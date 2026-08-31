import { Stack, Typography } from "@mui/material";
import { sortCurrencies } from "../../lib/currencies";
import { CurrencyIcon } from "./CurrencyIcon";

/**
 * Which currencies can book this, as issuer marks.
 *
 * Takes the raw `transfer_currencies` blob rather than a parsed list because
 * every caller has it in that form, and a malformed one renders an em-dash
 * rather than throwing — "we don't know who can book it" is a legitimate cell.
 */
export function BookableCurrencies({
  json,
  size,
  note,
}: {
  json?: string;
  size?: number;
  note?: string;
}) {
  let codes: string[] = [];
  try {
    codes = json ? (JSON.parse(json) as string[]) : [];
  } catch {
    codes = [];
  }
  if (codes.length === 0)
    return (
      <Typography component="span" color="text.disabled">
        —
      </Typography>
    );
  return (
    <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: "wrap", alignItems: "center" }}>
      {sortCurrencies(codes).map((c) => (
        <CurrencyIcon key={c} code={c} size={size} note={note} />
      ))}
    </Stack>
  );
}