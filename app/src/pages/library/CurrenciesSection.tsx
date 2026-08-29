import {
  Box,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
  useTheme,
} from "@mui/material";
import AccountBalanceWalletRoundedIcon from "@mui/icons-material/AccountBalanceWalletRounded";
import { readable } from "../../theme/build";
import {
  CURRENCY_COLOR,
  CURRENCY_LABEL,
  NEUTRAL_COLOR,
  resolveColor,
} from "../../lib/currencies";
import { CurrencyIcon } from "../../components/brand";
import { ProgramTileGrid } from "./BrandTile";
import { SectionHeader } from "../../components/SectionHeader";
import type { CurrencyInfo, ProgramInfo } from "../../api";

/** The couple's transfer currencies, and what each one reaches.
 *
 *  This table is the LEGEND for the mark every other screen draws — which is why
 *  the short name is still spelled out here, in text, beside the icon. */
export function CurrenciesSection({
  currencies,
  programs,
}: {
  currencies: CurrencyInfo[];
  programs: ProgramInfo[];
}) {
  const theme = useTheme();
  if (currencies.length === 0) return null;
  const progsFor = (code: string) =>
    programs.filter((p) => p.transfer_partners.some((tp) => tp.currency === code));

  return (
    <Box>
      <SectionHeader
        title="Currencies"
        icon={<AccountBalanceWalletRoundedIcon sx={{ color: "secondary.main" }} />}
        count={currencies.length}
      />
      <TableContainer component={Paper} elevation={0}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Currency</TableCell>
              <TableCell>Code</TableCell>
              <TableCell align="right">Transfers to</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {currencies.map((cur) => {
              const color = readable(
                resolveColor(CURRENCY_COLOR[cur.code] ?? NEUTRAL_COLOR, theme.palette.text.secondary),
                theme,
              );
              const progs = progsFor(cur.code);
              const n = progs.length;
              return (
                <TableRow key={cur.code} hover sx={{ "&:last-child td": { border: 0 } }}>
                  <TableCell>
                    <Stack direction="row" spacing={1.25} sx={{ alignItems: "center" }}>
                      <CurrencyIcon code={cur.code} size={24} />
                      <Typography sx={{ fontWeight: 600 }}>{cur.name}</Typography>
                    </Stack>
                  </TableCell>
                  {/* This table is the LEGEND for the mark every other screen
                      shows, so the short name stays spelled out here — as plain
                      accented text rather than a badge, because the icon that
                      badge would have become is already in the cell beside it. */}
                  <TableCell>
                    <Typography variant="body2" sx={{ color, fontWeight: 600 }}>
                      {CURRENCY_LABEL[cur.code] ?? cur.code}
                    </Typography>
                  </TableCell>
                  <TableCell align="right">
                    {n > 0 ? (
                      <Tooltip
                        arrow
                        title={<ProgramTileGrid programs={progs} />}
                        slotProps={{
                          tooltip: {
                            sx: {
                              maxWidth: "none",
                              bgcolor: "background.paper",
                              border: (t) => `1px solid ${t.palette.divider}`,
                              boxShadow: 6,
                              p: 0.75,
                            },
                          },
                          arrow: { sx: { color: "background.paper" } },
                        }}
                      >
                        <Typography
                          component="span"
                          sx={{
                            fontWeight: 600,
                            fontVariantNumeric: "tabular-nums",
                            cursor: "default",
                            textDecoration: "underline dotted",
                            textUnderlineOffset: 3,
                          }}
                        >
                          {n} {n === 1 ? "program" : "programs"}
                        </Typography>
                      </Tooltip>
                    ) : (
                      <Typography variant="body2" color="text.disabled" sx={{ fontStyle: "italic" }}>
                        in-program miles
                      </Typography>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}
