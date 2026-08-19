import {
  Box,
  Chip,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
  useTheme,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import FlightTakeoffRoundedIcon from "@mui/icons-material/FlightTakeoffRounded";
import { flagEmoji } from "../../lib/format";
import { AIRLINE_DOMAIN, allianceColor, CURRENCY_ORDER, shortProgramName, tileColor } from "./brands";
import { AllianceChip } from "./AllianceChip";
import { BrandTile } from "./BrandTile";
import { CurrencyIcons } from "../../components/TransferCurrencies";
import { SectionHeader } from "../../components/SectionHeader";
import type { AirlineInfo, ProgramInfo } from "../../api";

/** Carriers, and which miles buy a seat on them. The program codes come from
 *  core's seed alliance table (`/api/airlines`); their names, colors and transfer
 *  partners are joined from the D1 programs table, so a program deactivated
 *  there disappears from these rows too. */
export function AirlinesSection({
  airlines,
  programs,
}: {
  airlines: AirlineInfo[];
  programs: ProgramInfo[];
}) {
  const theme = useTheme();
  if (airlines.length === 0) return null;
  const byCode = new Map(programs.map((p) => [p.code, p]));

  return (
    <Box>
      <SectionHeader
        title="Airlines"
        icon={<FlightTakeoffRoundedIcon sx={{ color: "secondary.main" }} />}
        count={airlines.length}
      />
      <TableContainer component={Paper} elevation={0}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Airline</TableCell>
              <TableCell>Alliance</TableCell>
              <TableCell>Miles you can spend</TableCell>
              <TableCell>Transfer from</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {airlines.map((a) => {
              const progs = a.programs
                .map((code) => byCode.get(code))
                .filter((p): p is ProgramInfo => Boolean(p));
              const currencies = CURRENCY_ORDER.filter((cur) =>
                progs.some((p) => p.transfer_partners.some((tp) => tp.currency === cur)),
              );
              const color = allianceColor(a.alliance, theme);
              return (
                <TableRow key={a.code} hover sx={{ "&:last-child td": { border: 0 } }}>
                  <TableCell>
                    <Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
                      <BrandTile
                        name={a.name}
                        domain={AIRLINE_DOMAIN[a.code]}
                        color={color}
                        size={34}
                      />
                      <Box>
                        <Typography sx={{ fontWeight: 600, lineHeight: 1.2 }}>
                          {flagEmoji(a.country)} {a.name}
                        </Typography>
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{ letterSpacing: "0.04em" }}
                        >
                          {a.code}
                        </Typography>
                      </Box>
                    </Stack>
                  </TableCell>
                  <TableCell>
                    <AllianceChip alliance={a.alliance} />
                  </TableCell>
                  <TableCell sx={{ width: "42%" }}>
                    <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: "wrap" }}>
                      {progs.map((p) => {
                        const c = tileColor(p, theme);
                        return (
                          <Chip
                            key={p.code}
                            size="small"
                            label={shortProgramName(p.name)}
                            sx={{
                              color: c,
                              bgcolor: alpha(c, 0.14),
                              border: `1px solid ${alpha(c, 0.3)}`,
                            }}
                          />
                        );
                      })}
                    </Stack>
                  </TableCell>
                  <TableCell>
                    <CurrencyIcons codes={currencies} />
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
