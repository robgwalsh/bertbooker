import type { ReactNode } from "react";
import { TableCell, TableSortLabel } from "@mui/material";
import type { SxProps, Theme } from "@mui/material/styles";
import type { SortState } from "./findSort";

// One sortable column heading, shared by the two results tables so a click
// means the same thing in both. Generic over the key set because the two tables
// sort by different column lists — see `findSort.ts`.
export function SortHeadCell<K extends string>({
  column,
  sort,
  onSort,
  align,
  sx,
  children,
}: {
  column: K;
  sort: SortState<K>;
  onSort: (key: K) => void;
  align?: "right";
  sx?: SxProps<Theme>;
  children: ReactNode;
}) {
  const active = sort.key === column;
  return (
    // `sortDirection` is what puts `aria-sort` on the cell; `TableSortLabel`
    // carries the arrow and the button semantics. Both halves are needed — the
    // label alone announces a button with no indication of what it did.
    <TableCell align={align} sortDirection={active ? sort.dir : false} sx={sx}>
      <TableSortLabel
        active={active}
        // An inactive column points up because that is where one click will
        // take it; MUI shows that arrow only on hover.
        direction={active ? sort.dir : "asc"}
        onClick={() => onSort(column)}
      >
        {children}
      </TableSortLabel>
    </TableCell>
  );
}
