import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Box, CircularProgress, LinearProgress, Stack, Typography } from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import BoltRoundedIcon from "@mui/icons-material/BoltRounded";
import { api } from "../api";
import {
  PRIMARY_METERED_SOURCE,
  QUOTA_CHIP_ID,
  quotaDetailLines,
  quotaToneColor,
  summarizeQuota,
} from "../lib/quota";

/** How long the shrink takes. Short on purpose: this is an acknowledgement, not
 *  a transition to wait through. Must match the CSS transition below. */
const FLIGHT_MS = 420;

/** Nothing here blocks the app for long, but a splash that can only be
 *  dismissed by an interaction would sit forever on a screen nobody is at. */
const AUTO_DISMISS_MS = 8_000;

/**
 * What the day's metered allowance stands at, shown once, at unlock.
 *
 * Every other surface reports this number *after* something has spent it — the
 * app-bar chip is a thing you glance at, and the search panel quotes it in
 * hindsight. This is the one moment it is the whole screen, before any decision
 * about what to search has been made against it.
 *
 * Then it gets out of the way. Any click, key, scroll or touch shrinks the card
 * into the app-bar chip it becomes (`QUOTA_CHIP_ID`) — the same number, in the
 * place it lives from then on, so the chip is learned rather than discovered.
 * The animation is measured, not scripted: the card reads both rectangles at
 * dismiss time, so it lands on the chip wherever the toolbar has put it.
 *
 * It reads the same `["quota"]` key as the chip and the finds table's
 * enrich controls, through the same `summarizeQuota`, so the two cannot disagree
 * — and it costs no request of its own beyond the one the app was making anyway.
 * **Displays, never enforces** (see `QuotaIndicator`).
 */
export function QuotaSplash({ onDone }: { onDone: () => void }) {
  const q = useQuery({ queryKey: ["quota"], queryFn: api.quota });
  const theme = useTheme();
  const cardRef = useRef<HTMLDivElement>(null);
  const [closing, setClosing] = useState(false);
  // Guards the unmount against arriving twice (a click and the timer, or a
  // second key on the way out).
  const finished = useRef(false);

  const finish = useCallback(() => {
    if (finished.current) return;
    finished.current = true;
    onDone();
  }, [onDone]);

  const close = useCallback(() => {
    if (finished.current) return;
    setClosing(true);

    const card = cardRef.current;
    const target = document.getElementById(QUOTA_CHIP_ID);
    if (card && target) {
      const from = card.getBoundingClientRect();
      const to = target.getBoundingClientRect();
      // Centre-to-centre plus a scale down to the chip's width. Written straight
      // onto the node rather than through state: React never sets `style` on
      // this element, so nothing will overwrite it, and the browser gets the new
      // transform in the same frame as the transition it is animating.
      const dx = to.left + to.width / 2 - (from.left + from.width / 2);
      const dy = to.top + to.height / 2 - (from.top + from.height / 2);
      const scale = from.width > 0 ? Math.max(to.width / from.width, 0.04) : 0.1;
      card.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
      card.style.opacity = "0";
    }
    // Unmount when the flight lands — or immediately-ish if there was no chip to
    // fly into (no metered source has reported, so the app bar draws nothing).
    window.setTimeout(finish, card && target ? FLIGHT_MS : 160);
  }, [finish]);

  // Any interaction at all dismisses it. `pointerdown`/`keydown` are the two the
  // brief names; `wheel` and `touchstart` are here because a scroll or a swipe
  // is just as clearly "I've read it" and neither fires the other two.
  useEffect(() => {
    const dismiss = () => close();
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", dismiss);
    window.addEventListener("wheel", dismiss, { passive: true });
    window.addEventListener("touchstart", dismiss, { passive: true });
    const timer = window.setTimeout(dismiss, AUTO_DISMISS_MS);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", dismiss);
      window.removeEventListener("wheel", dismiss);
      window.removeEventListener("touchstart", dismiss);
      window.clearTimeout(timer);
    };
  }, [close]);

  const summaries = summarizeQuota(q.data);
  const primary =
    summaries.find((s) => s.source === PRIMARY_METERED_SOURCE) ?? summaries[0];
  // The summary carries a TONE, not a colour — see `QuotaSummary.tone`. Resolved
  // once here so every part of the card is painted the same one.
  const accent = quotaToneColor(primary?.tone ?? "ok", theme);

  // Nothing metered has ever reported, or the quota call failed. The app bar
  // would draw no chip either, so there is nothing to say and nowhere to fly to
  // — leave without a flash of an empty card.
  useEffect(() => {
    if (!q.isPending && !primary) finish();
  }, [q.isPending, primary, finish]);

  return (
    <Box
      // Above the app bar (MUI's `appBar` z-index is 1100) but not a modal: the
      // app is already mounted and rendering behind this, which is the point —
      // the card shrinks into a toolbar that is really there.
      sx={{
        position: "fixed",
        inset: 0,
        zIndex: 1400,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        p: 3,
        bgcolor: (t) => alpha(t.palette.background.default, 0.86),
        backdropFilter: "blur(10px)",
        opacity: closing ? 0 : 1,
        transition: `opacity ${FLIGHT_MS}ms ease`,
        cursor: "pointer",
      }}
    >
      {primary ? (
        <Box
          ref={cardRef}
          sx={{
            width: "min(420px, 100%)",
            px: 4,
            py: 4,
            textAlign: "center",
            borderRadius: 4,
            border: `1px solid ${alpha(accent, 0.35)}`,
            bgcolor: "background.paper",
            backgroundImage: (t) =>
              `linear-gradient(180deg, ${alpha(accent, 0.14)}, ${alpha(
                t.palette.common.black,
                0,
              )} 65%)`,
            boxShadow: `0 24px 70px ${alpha(accent, 0.28)}`,
            // Cleared the moment it starts closing, so the entrance can't fight
            // the imperative transform that flies it into the chip.
            animation: closing ? "none" : "quotaSplashIn 320ms cubic-bezier(.2,.8,.3,1)",
            "@keyframes quotaSplashIn": {
              from: { opacity: 0, transform: "translateY(10px) scale(.94)" },
              to: { opacity: 1, transform: "none" },
            },
            transition: `transform ${FLIGHT_MS}ms cubic-bezier(.5,0,.75,0), opacity ${FLIGHT_MS}ms ease-in`,
            willChange: "transform, opacity",
          }}
        >
          <Stack spacing={0.5} sx={{ alignItems: "center" }}>
            <BoltRoundedIcon sx={{ fontSize: 30, color: accent }} />
            <Typography variant="overline" color="text.secondary">
              {primary.label}
            </Typography>

            <Stack
              direction="row"
              spacing={0.75}
              sx={{ alignItems: "baseline", justifyContent: "center", pt: 0.5 }}
            >
              <Typography
                sx={{
                  fontSize: 56,
                  fontWeight: 800,
                  lineHeight: 1,
                  letterSpacing: "-0.03em",
                  color: accent,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {primary.remaining.toLocaleString()}
              </Typography>
              <Typography
                variant="h6"
                color="text.secondary"
                sx={{ fontVariantNumeric: "tabular-nums" }}
              >
                / {primary.limit.toLocaleString()}
              </Typography>
            </Stack>
            <Typography variant="body2" color="text.secondary">
              calls left today
            </Typography>

            <LinearProgress
              variant="determinate"
              value={primary.pct}
              sx={{
                width: "100%",
                mt: 2,
                height: 6,
                borderRadius: 999,
                bgcolor: alpha(accent, 0.16),
                "& .MuiLinearProgress-bar": { bgcolor: accent, borderRadius: 999 },
              }}
            />

            <Stack spacing={0.25} sx={{ pt: 2 }}>
              {quotaDetailLines(primary, Date.now()).map((line) => (
                <Typography key={line} variant="caption" color="text.secondary">
                  {line}
                </Typography>
              ))}
              <Typography variant="caption" sx={{ color: "text.disabled" }}>
                Previously fetched data is staill available while seats.aero quota is exhausted.
              </Typography>
            </Stack>

            {/* The other half of that sentence is where it goes, which the
                animation then demonstrates. */}
            <Typography variant="caption" sx={{ pt: 2, color: "text.disabled" }}>
              Click anywhere to continue
            </Typography>
          </Stack>
        </Box>
      ) : q.isPending ? (
        <CircularProgress size={28} />
      ) : null}
    </Box>
  );
}
