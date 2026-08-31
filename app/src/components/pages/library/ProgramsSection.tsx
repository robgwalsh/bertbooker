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
  Typography,
} from "@mui/material";
import { AllianceChip } from "../../brand/AllianceChip";
import { ProgramTile } from "./BrandTile";
import { SectionHeader } from "../../SectionHeader";
import type { ProgramInfo } from "../../../api";
import { TransferCurrencies } from "./TransferCurrencies";

/** A table of loyalty programs — airline or hotel, whichever set the caller
 *  filtered to. Named for what it lists: it was `Section`, which is a name that
 *  says only that it is part of a page. */
export function ProgramsSection({
  title,
  icon,
  programs,
}: {
  title: string;
  icon: React.ReactNode;
  programs: ProgramInfo[];
}) {
  if (programs.length === 0) return null;
  return (
    <Box>
      <SectionHeader title={title} icon={icon} count={programs.length} />
      <TableContainer component={Paper} elevation={0}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Program</TableCell>
              <TableCell>Alliance</TableCell>
              <TableCell>Transfer from</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {programs.map((p) => (
              <TableRow key={p.code} hover sx={{ "&:last-child td": { border: 0 } }}>
                <TableCell>
                  <Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
                    <ProgramTile program={p} size={34} />
                    <Box>
                      <Typography sx={{ fontWeight: 600, lineHeight: 1.2 }}>{p.name}</Typography>
                      <Typography variant="caption" color="text.secondary" sx={{ letterSpacing: "0.04em" }}>
                        {p.code}
                      </Typography>
                    </Box>
                  </Stack>
                </TableCell>
                <TableCell>
                  <AllianceChip alliance={p.alliance} />
                </TableCell>
                <TableCell sx={{ width: "45%" }}>
                  <TransferCurrencies partners={p.transfer_partners} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}
