import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  IconButton,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import { api } from "../../api";
import { ApiError } from "../../api/client";
import { Section } from "./SettingsDialog";

/**
 * The System tab: who this deployment may email an alert digest to.
 *
 * The allowlist exists because one shared password is the only auth here, so an
 * unchecked per-route "Send to" would make the Worker an arbitrary-recipient
 * sender on a Resend-verified domain — and the domain's sending reputation is
 * not something a typo should be able to spend. It used to be
 * `ALERT_ALLOWED_RECIPIENTS`, a CSV env binding, which meant a deploy per edit.
 *
 * Unlike the Preferences tab beside it, this writes to a server and can be
 * refused, so every action is explicit and every refusal is shown as the
 * sentence the Worker wrote. See the docblock in `SettingsDialog.tsx`.
 */
export function SystemSettings() {
  const qc = useQueryClient();
  const [email, setEmail] = useState("");

  const q = useQuery({ queryKey: ["alert-recipients"], queryFn: api.alertRecipients });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["alert-recipients"] });

  const add = useMutation({
    mutationFn: () => api.addAlertRecipient({ email }),
    onSuccess: () => {
      setEmail("");
      void invalidate();
    },
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.deleteAlertRecipient(id),
    onSuccess: () => void invalidate(),
  });

  const submit = () => {
    if (!email.trim() || add.isPending) return;
    add.mutate();
  };

  return (
    <Section title="Outgoing e-mail whitelist">
      {q.isPending && <CircularProgress size={20} sx={{ my: 1 }} />}
      {q.isError && (
        <Alert severity="error" sx={{ my: 1 }}>
          {errorText(q.error, "Could not load the recipient list.")}
        </Alert>
      )}

      {q.data && (
        <Stack sx={{ mb: 1.5 }}>
          {q.data.accountAddress ? (
            <AccountRow email={q.data.accountAddress} />
          ) : (
            // Not a styling case — a deployment with no APP_USER_EMAIL cannot
            // attribute a sweep and the cron refuses to start (docs/ALERTS.md
            // §3), so this is the fault, not an empty state.
            <Alert severity="warning" sx={{ mb: 1 }}>
              No account address: <code>APP_USER_EMAIL</code> is unset, so nothing
              can be emailed and the alerts cron will not run.
            </Alert>
          )}

          {q.data.recipients.map((r) => (
            <RecipientRow
              key={r.id}
              email={r.email}
              onDelete={() => remove.mutate(r.id)}
              busy={remove.isPending && remove.variables === r.id}
            />
          ))}
        </Stack>
      )}

      {remove.isError && (
        <Alert severity="error" sx={{ mb: 1.5 }} onClose={() => remove.reset()}>
          {errorText(remove.error, "Could not remove that address.")}
        </Alert>
      )}

      <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
        <TextField
          label="Add an address"
          size="small"
          type="email"
          fullWidth
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            // Clearing on edit rather than on submit, so a stale "already
            // allowed" does not sit under an address you have since changed.
            if (add.isError) add.reset();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          sx={{ maxWidth: 360 }}
        />
        <Button
          variant="outlined"
          size="small"
          startIcon={<AddRoundedIcon />}
          onClick={submit}
          disabled={!email.trim() || add.isPending}
          sx={{ mt: 0.25 }}
        >
          Add
        </Button>
      </Stack>

      {add.isError && (
        <Alert severity="error" sx={{ mt: 1.5 }}>
          {errorText(add.error, "Could not add that address.")}
        </Alert>
      )}
    </Section>
  );
}

/**
 * The account's own address, which is always allowed and has no delete control.
 *
 * It is `APP_USER_EMAIL` and is never a row in the table, so it cannot be
 * removed — which is what stops an empty list meaning "this deployment can email
 * nobody". It is also where a route with no explicit recipient sends.
 */
function AccountRow({ email }: { email: string }) {
  return (
    <Row>
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography variant="body2" noWrap>
          {email}
        </Typography>
      </Box>
      <Tooltip title="Set by APP_USER_EMAIL — cannot be removed here">
        <LockOutlinedIcon fontSize="small" sx={{ color: "text.disabled", mr: 1 }} />
      </Tooltip>
    </Row>
  );
}

function RecipientRow({
  email,
  onDelete,
  busy,
}: {
  email: string;
  onDelete: () => void;
  busy: boolean;
}) {
  return (
    <Row>
      <Typography variant="body2" noWrap sx={{ minWidth: 0, flex: 1 }}>
        {email}
      </Typography>
      <IconButton
        size="small"
        aria-label={`Remove ${email}`}
        onClick={onDelete}
        disabled={busy}
      >
        {busy ? <CircularProgress size={16} /> : <DeleteOutlineRoundedIcon fontSize="small" />}
      </IconButton>
    </Row>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <Stack
      direction="row"
      spacing={1}
      sx={{
        alignItems: "center",
        py: 0.75,
        borderBottom: (t) => `1px solid ${t.palette.divider}`,
      }}
    >
      {children}
    </Stack>
  );
}

/** The Worker's own sentence where it wrote one — `bad_email`, `duplicate_recipient`
 *  and `recipient_in_use` all carry the whole explanation, including the count of
 *  routes still pointing at an address. */
function errorText(err: unknown, fallback: string): string {
  return (err instanceof ApiError && err.detail) || fallback;
}
