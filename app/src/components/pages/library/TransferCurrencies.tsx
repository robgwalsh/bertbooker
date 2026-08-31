import { Stack, Typography } from "@mui/material";
import { CurrencyIcon } from "../../brand/CurrencyIcon";
import { sortCurrencies } from "../../../lib/currencies";
import type { ProgramInfo } from "../../../api/index";

/** Which currencies transfer into a program, as issuer marks.
 *
 *  The ratio is the one thing the mark can't say, and it is the reason this isn't
 *  just `BookableCurrencies`: a 1:1 transfer is the norm and stays silent, while
 *  anything else is printed beside the icon — a 1.5:1 partner priced as if it
 *  were 1:1 is a wrong answer, not a missing detail. */
export function TransferCurrencies({ partners }: { partners: ProgramInfo["transfer_partners"] }) {
  if (partners.length === 0) {
    return (
      <Typography variant="body2" color="text.disabled" sx={{ fontStyle: "italic" }}>
        Partner bookings only — no direct transfer
      </Typography>
    );
  }
  return (
    <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: "wrap", alignItems: "center" }}>
      {partners.map((tp) => {
        const odd = tp.ratio !== "1:1";
        return (
          <Stack
            key={tp.currency}
            direction="row"
            spacing={0.4}
            sx={{ alignItems: "center" }}
          >
            <CurrencyIcon
              code={tp.currency}
              note={odd ? `transfers at ${tp.ratio}` : "transfers 1:1"}
            />
            {odd && (
              <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
                {tp.ratio}
              </Typography>
            )}
          </Stack>
        );
      })}
    </Stack>
  );
}

/** The same marks with no ratios — what a carrier's row shows, where the
 *  question is only "which of my cards reaches this airline at all". */
export function CurrencyIcons({ codes }: { codes: string[] }) {
  if (codes.length === 0) {
    return (
      <Typography variant="body2" color="text.disabled" sx={{ fontStyle: "italic" }}>
        in-program miles only
      </Typography>
    );
  }
  return (
    <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: "wrap", alignItems: "center" }}>
      {sortCurrencies(codes).map((code) => (
        <CurrencyIcon key={code} code={code} />
      ))}
    </Stack>
  );
}
