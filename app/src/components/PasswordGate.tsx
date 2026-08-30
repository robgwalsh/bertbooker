import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import GitHubIcon from "@mui/icons-material/GitHub";
import RocketLaunchRoundedIcon from "@mui/icons-material/RocketLaunchRounded";
import { ApiError, api, type LoginResult } from "../api";
import {
  clearSessionHint,
  onLocked,
  readSessionHint,
  writeSessionHint,
  type SessionHint,
} from "../lib/auth";
import { QuotaSplash } from "./QuotaSplash";

/**
 * The front door. Wraps the whole app: nothing renders until the Worker has
 * agreed the shared password was given (`api/src/middleware/gate.ts`).
 *
 * It is a gate, not a decoration — the API refuses every `/api/*` call without a
 * valid session regardless of what the SPA draws. What this component buys is
 * that the app doesn't render as a wall of failed panels while locked, and that
 * a session lapsing mid-session re-prompts instead of breaking quietly.
 *
 * Three states are deliberately distinct, because the remedies are:
 *
 * - **locked** — a password is wanted. Show the dialog over an empty backdrop.
 * - **not configured** — the Worker is missing `APP_PASSWORD` or
 *   `SESSION_SECRET`, so no password can work. Prompting would be a lie; name
 *   the missing secret instead.
 * - **unreachable** — the session check itself failed. Render the app and let
 *   its own error states speak, rather than blaming the user's password for a
 *   dead API.
 *
 * Nothing in this component ever holds the session. It is an HttpOnly cookie
 * (`api/src/middleware/gate.ts`); what `session` tracks here is only whether we
 * believe one exists, seeded from an expiry hint and corrected by the Worker.
 */
export function PasswordGate({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  // Seeded from the stored expiry hint so a returning user inside their 8 hours
  // goes straight to the app instead of watching a spinner while the check
  // below runs. That check is authoritative and corrects this if wrong.
  const [session, setSession] = useState<SessionHint | null>(() => readSessionHint());

  // Set only by a password actually being typed — never by the stored session
  // above. Unlocking is the one moment the day's metered allowance is worth the
  // whole screen; a reload inside the same 8 hours is not.
  const [splash, setSplash] = useState(false);

  const check = useQuery({
    queryKey: ["auth", "session"],
    queryFn: api.session,
    staleTime: Infinity,
    retry: false,
    // A tab left open overnight comes back to a lapsed session; re-checking on
    // focus raises the dialog before the user clicks something that fails.
    refetchOnWindowFocus: true,
  });

  // Any gated call that comes back `locked` lands here — see `auth.ts`.
  useEffect(() => onLocked(() => setSession(null)), []);

  // The Worker disagrees that we're signed in (rotated password or
  // SESSION_SECRET, expired cookie, clock skew). Its answer wins.
  const serverAuthenticated = check.data?.authenticated;
  useEffect(() => {
    if (serverAuthenticated === false && readSessionHint()) {
      clearSessionHint();
      setSession(null);
    }
  }, [serverAuthenticated]);

  // Lock exactly when the session lapses, rather than on the next failed call.
  useEffect(() => {
    if (!session) return;
    const remaining = session.expiresAt * 1000 - Date.now();
    if (remaining <= 0) {
      clearSessionHint();
      setSession(null);
      return;
    }
    const timer = setTimeout(() => {
      clearSessionHint();
      setSession(null);
    }, remaining);
    return () => clearTimeout(timer);
  }, [session]);

  const handleSuccess = useCallback(
    (result: LoginResult) => {
      writeSessionHint(result);
      setSession(result);
      setSplash(true);
      // Anything that failed while locked out is holding an error; refetch it all
      // now that requests will be answered. The splash reads `["quota"]`,
      // so this is also the fetch that fills it in.
      void queryClient.invalidateQueries();
    },
    [queryClient],
  );

  if (check.data && !check.data.configured) return <NotConfigured reason={check.data.reason} />;
  if (session)
    return (
      <>
        {/* Rendered BESIDE the app, not instead of it: the splash shrinks into
            the app bar's quota chip, so that chip has to be mounted and laid out
            underneath before the animation can measure where it landed. */}
        {children}
        {splash && <QuotaSplash onDone={() => setSplash(false)} />}
      </>
    );
  if (check.isPending) return <Centered>{<CircularProgress size={28} />}</Centered>;
  // The check itself failed: the API is down or unreachable, which is not
  // something a password fixes.
  if (check.isError) return <>{children}</>;

  return (
    <>
      {/* An empty page behind the dialog. Not the app — a locked app should show
          nothing — and not a spinner either, which would claim work is underway
          while we sit waiting for a human to type. */}
      <Centered>{null}</Centered>
      <LoginDialog onSuccess={handleSuccess} />
    </>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <Box
      sx={{
        // `dvh`, not `vh`: on iOS `100vh` is the tall viewport, so the centred
        // dialog sits low enough that the URL bar covers its buttons.
        minHeight: "100dvh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        p: 3,
      }}
    >
      {children}
    </Box>
  );
}

/**
 * What each refusal means to the person typing.
 *
 * A map rather than a ternary chain because the list grew: only `bad_password`
 * and `too_many_attempts` are things the typist can do anything about, and the
 * rest are facts about the server. The fallback is deliberately the LEAST
 * specific message, so a code nobody has mapped yet reads as "something is
 * wrong" instead of borrowing the wrong explanation.
 */
const LOGIN_ERRORS: Record<string, string> = {
  bad_password: "That password isn't right.",
  // A 429 is not a wrong password and must not read as one — telling someone
  // their correct password is wrong is how a throttle turns into a support call.
  too_many_attempts: "Too many attempts from here. Wait a minute and try again.",
  no_app_password: "The API has no APP_PASSWORD configured.",
  no_session_secret: "The API has no SESSION_SECRET configured.",
};

function LoginDialog({ onSuccess }: { onSuccess: (result: LoginResult) => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      onSuccess(await api.login(password));
    } catch (err) {
      setPassword("");
      setError(
        (err instanceof ApiError && err.code ? LOGIN_ERRORS[err.code] : undefined) ??
          "Couldn't reach the API. Check that it's running and try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    // No `onClose` — which is also what makes it undismissable: MUI closes only
    // through that callback, so Escape and backdrop clicks have nowhere to go.
    <Dialog open maxWidth="xs" fullWidth>
      <Box component="form" onSubmit={submit}>
        <DialogTitle>
          <Stack direction="row" spacing={1.25} sx={{ alignItems: "center" }}>
            <LockOutlinedIcon fontSize="small" color="primary" />
            <span>BertBooker</span>
          </Stack>
        </DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            Enter the shared password. You'll stay signed in on this device for 8 hours.
          </DialogContentText>
          <TextField
            autoFocus
            fullWidth
            size="small"
            type="password"
            label="Password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            slotProps={{ inputLabel: { shrink: true } }}
          />
          {error && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {error}
            </Alert>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button type="submit" variant="contained" disabled={!password || busy}>
            {busy ? "Checking…" : "Unlock"}
          </Button>
        </DialogActions>
      </Box>
      <SelfHostNote />
    </Dialog>
  );
}

/** Where the source lives. Also the README anchor, so the link lands on the
 *  intro rather than halfway down a long file. */
const REPO_URL = "https://github.com/robgwalsh/bertbooker#bertbooker";

/**
 * The way out for someone who doesn't have the password.
 *
 * The gate has exactly one key and it isn't handed out, so a stranger who
 * reaches this dialog has no move — except that the whole thing is open source
 * and a seats.aero key is theirs to buy. Saying so here is the only place it can
 * be said: this dialog is the entire app to anyone locked out.
 *
 * Drawn as a footer BELOW the actions, in a tinted ground rather than an
 * `Alert`, so it reads as an invitation and cannot be mistaken for the error
 * slot above it.
 */
function SelfHostNote() {
  return (
    <Box
      sx={{
        px: 3,
        pt: 2.25,
        pb: 2.5,
        // A ground, not ink — the tint carries the emphasis so the text can stay
        // ordinary body colour and remain readable in every theme.
        bgcolor: (t) => alpha(t.palette.primary.main, 0.07),
        backgroundImage: (t) =>
          `linear-gradient(180deg, ${alpha(t.palette.primary.main, 0.06)}, transparent 70%)`,
      }}
    >
      <Divider sx={{ mb: 2, mt: -2.25, mx: -3 }} />
      <Stack direction="row" spacing={1.5} sx={{ alignItems: "flex-start" }}>
        <RocketLaunchRoundedIcon fontSize="small" color="primary" sx={{ mt: 0.25 }} />
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="subtitle2" gutterBottom>
            No password? Run your own.
          </Typography>
          <Typography variant="body2" color="text.secondary">
            BertBooker is open source. Bring your own seats.aero API key.
          </Typography>
          <Button
            component="a"
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            size="small"
            variant="outlined"
            startIcon={<GitHubIcon fontSize="small" />}
            sx={{ mt: 1.5 }}
          >
            Get it on GitHub
          </Button>
        </Box>
      </Stack>
    </Box>
  );
}

/**
 * The Worker is missing a secret the gate needs. Every `/api/*` call is
 * answering 503, so the app would render as a wall of failures; name the actual
 * cause — and, since there are now two of them with two different fixes, name
 * which one.
 *
 * `SESSION_SECRET` fails closed rather than falling back to a password-derived
 * key on purpose: the fallback would be the very weakness that secret exists to
 * remove, and it would be invisible. See `api/src/middleware/gate.ts`.
 */
function NotConfigured({ reason }: { reason?: "no_app_password" | "no_session_secret" }) {
  const name = reason === "no_session_secret" ? "SESSION_SECRET" : "APP_PASSWORD";
  const what =
    reason === "no_session_secret"
      ? "no key to sign sessions with"
      : "no password configured";
  return (
    <Centered>
      <Alert severity="warning" sx={{ maxWidth: 520 }}>
        <Typography variant="subtitle2" gutterBottom>
          The API has {what}
        </Typography>
        <Typography variant="body2">
          Set <code>{name}</code> — a line in <code>api/.dev.vars</code> locally, or{" "}
          <code>wrangler secret put {name}</code> in production — and reload. Until then the API
          refuses every request rather than serving the app unprotected.
        </Typography>
      </Alert>
    </Centered>
  );
}
