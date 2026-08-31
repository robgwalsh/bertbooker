import { useRef, useState } from "react";
import {
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  MenuItem,
  MenuList,
  Popover,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { BookableCurrencies } from "../../brand/BookableCurrencies";
import { CabinChip } from "../../brand/CabinChip";
import { CurrencyIcon } from "../../brand/CurrencyIcon";
import { CURRENCY_LABEL } from "../../../lib/currencies";
import { miles } from "../../../lib/format";
import { parseCodeList } from "../../../lib/routeShape";
import { useIsPhone } from "../../../hooks/useBreakpoints";
import { CABIN_OPTIONS, FILTER_CURRENCIES } from "./constants";
import { MUTED_CHIP_SX, SpecValue } from "./SpecValue";
import { parsePointLimit } from "./form";
import { useRouteFilterPatch, type FilterField } from "./useRouteFilterPatch";
import type { TrackedRoute } from "../../../api/index";

/**
 * A route's READ FILTERS, edited where they are stated.
 */
export function RouteFilterChips({ route }: { route: TrackedRoute }) {
  const phone = useIsPhone();
  const filters = useRouteFilterPatch(route.id);

  const cabins = parseCodeList(route.cabins);
  const currencies = parseCodeList(route.currencies);
  const minSeats = route.min_seats ?? 1;
  const directOnly = Boolean(route.direct_only);
  const pointLimit = route.point_limit;

  const shared = { filters, route };

  if (phone) {
    const active =
      (cabins.length ? 1 : 0) +
      (currencies.length ? 1 : 0) +
      (minSeats > 1 ? 1 : 0) +
      (directOnly ? 1 : 0) +
      (pointLimit != null ? 1 : 0);
    return (
      <FilterChip
        {...shared}
        field="cabins"
        help="Cabins, cards, seats, routing and a points ceiling — all five decide what this route SHOWS. Everything they hide is still stored, so changing one costs no search."
        label={active ? `Filters · ${active}` : "Filters"}
        set={active > 0}
        dialogTitle="Filters"
      >
        {() => (
          <Stack sx={{ gap: 1.5 }}>
            <FilterSection title="Cabins">
              <CabinRows {...shared} cabins={cabins} />
            </FilterSection>
            <Divider />
            <FilterSection title="Book with">
              <CurrencyRows {...shared} currencies={currencies} />
            </FilterSection>
            <Divider />
            <FilterSection title="Seats">
              <SeatsToggle {...shared} minSeats={minSeats} />
            </FilterSection>
            <Divider />
            <FilterSection title="Routing">
              <NonstopSwitch {...shared} directOnly={directOnly} />
            </FilterSection>
            <Divider />
            <FilterSection title="Points ceiling">
              <PointLimitSelect {...shared} pointLimit={pointLimit} />
            </FilterSection>
          </Stack>
        )}
      </FilterChip>
    );
  }

  return (
    <>
      <FilterChip
        {...shared}
        field="cabins"
        help="Cabins. Results outside these are stored, just not shown here."
        label="Any cabin"
        set={cabins.length > 0}
        value={cabins.map((c) => (
          <CabinChip key={c} cabin={c} />
        ))}
      >
        {() => <CabinRows {...shared} cabins={cabins} />}
      </FilterChip>

      <FilterChip
        {...shared}
        field="currencies"
        help={currencies.length ? "" : "Cards: only space bookable with these."}
        label="Any card"
        set={currencies.length > 0}
        value={
          <BookableCurrencies
            json={route.currencies ?? undefined}
            size={20}
            note="only showing space bookable with this"
          />
        }
      >
        {() => <CurrencyRows {...shared} currencies={currencies} />}
      </FilterChip>

      <FilterChip
        {...shared}
        field="minSeats"
        help="Finds with fewer seats than this are hidden here."
        label={`${minSeats}+ seats`}
        set={minSeats > 1}
      >
        {(close) => <SeatsToggle {...shared} minSeats={minSeats} onDone={close} />}
      </FilterChip>

      <FilterChip
        {...shared}
        field="directOnly"
        help="Nonstop-only filters what this route SHOWS. Connecting itineraries are still gathered and still stored, so turning it off brings them straight back — no search, no API call."
        hint={directOnly ? "Click to show connections." : "Click to hide connections."}
        label={directOnly ? "Nonstop" : "Any routing"}
        set={directOnly}
        color="info"
        pressed={directOnly}
        onToggle={() => filters.set("directOnly", { directOnly: !directOnly })}
      />

      <FilterChip
        {...shared}
        field="pointLimit"
        help="A points ceiling filters what this route SHOWS. Dearer awards are still gathered and still stored, so raising it brings them straight back — no search, no API call."
        label={pointLimit != null ? `${miles(pointLimit)} max` : "No max"}
        set={pointLimit != null}
      >
        {(close) => <PointLimitField {...shared} pointLimit={pointLimit} onDone={close} />}
      </FilterChip>
    </>
  );
}

interface Shared {
  route: TrackedRoute;
  filters: ReturnType<typeof useRouteFilterPatch>;
}

/**
 * One filter's chip, and the surface it opens.
 */
function FilterChip({
  filters,
  field,
  help,
  hint,
  label,
  set,
  color,
  value,
  pressed,
  onToggle,
  dialogTitle,
  children,
}: Shared & {
  field: FilterField;
  help: string;
  hint?: string;
  /** What the chip says. On an unset filter this is the "Any …" wording. */
  label: string;
  /** Whether this filter currently constrains anything. */
  set: boolean;
  color?: "info";
  /** Chip content richer than a label — the card marks. */
  value?: React.ReactNode;
  pressed?: boolean;
  /** Given instead of `children` by a filter that toggles in place. */
  onToggle?: () => void;
  /** Open in a titled dialog with a Done button rather than a popover. For a
   *  body big enough to cover the screen, where a scrim is not a visible way
   *  out. */
  dialogTitle?: string;
  children?: (close: () => void) => React.ReactNode;
}) {
  // The trigger is `SpecValue`'s own Box, so the popover lands under the hover
  // ground rather than under the chip inside it, and Enter opens it exactly
  // where a click does.
  const anchor = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const pending = filters.pending === field;
  const failed = filters.failed === field;

  return (
    <>
      <SpecValue
        ref={anchor}
        testId={`filter-${field}`}
        help={failed ? `Could not save: ${String(filters.error)}` : help}
        hint={failed ? "Click to try again." : hint}
        expanded={open}
        pressed={pressed}
        onClick={onToggle ?? (() => setOpen(true))}
      >
        {set && value && !failed ? (
          value
        ) : (
          <Chip
            size="small"
            variant="outlined"
            color={failed ? "error" : set ? color : undefined}
            label={label}
            icon={pending ? <CircularProgress size={12} color="inherit" /> : undefined}
            sx={
              set || failed
                ? undefined
                : { ...MUTED_CHIP_SX, height: 20, fontSize: 11, "& .MuiChip-label": { px: 0.75 } }
            }
          />
        )}
      </SpecValue>
      {children &&
        (dialogTitle ? (
          // Deliberately NOT `fullScreen`, unlike the route dialogs: those are
          // long forms with a Save, this is five controls that have already
          // saved themselves. Leaving a scrim margin around it is what makes
          // "tap outside" a visible way out rather than a guess.
          <Dialog open={open} onClose={close} maxWidth="xs" fullWidth>
            <DialogTitle sx={{ pb: 1 }}>{dialogTitle}</DialogTitle>
            <DialogContent dividers>{children(close)}</DialogContent>
            {/* Done, not Apply or Cancel: every change here saved when you made
                it, so there is nothing pending to apply and nothing staged to
                take back. The button closes, and says only that. */}
            <DialogActions>
              <Button onClick={close} variant="contained">
                Done
              </Button>
            </DialogActions>
          </Dialog>
        ) : (
          <Popover
            open={open}
            anchorEl={anchor.current}
            onClose={close}
            anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
            transformOrigin={{ vertical: "top", horizontal: "left" }}
            slotProps={{ paper: { sx: { mt: 0.5 } } }}
          >
            {children(close)}
          </Popover>
        ))}
    </>
  );
}

function FilterSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 0.5 }}>
        {title}
      </Typography>
      {children}
    </Box>
  );
}

/** Unticking all four IS the empty list, which is what the wire means by "any
 *  cabin" — so there is nothing for a Clear button to do. */
function CabinRows({ filters, cabins }: Shared & { cabins: string[] }) {
  const toggle = (code: string) => {
    const next = cabins.includes(code) ? cabins.filter((c) => c !== code) : [...cabins, code];
    filters.set("cabins", { cabins: next });
  };
  return (
    <MenuList sx={{ py: 0.5, minWidth: 180 }}>
      {CABIN_OPTIONS.map((c) => (
        <MenuItem key={c} onClick={() => toggle(c)} sx={{ gap: 1 }}>
          <Checkbox size="small" checked={cabins.includes(c)} sx={{ p: 0 }} />
          <CabinChip cabin={c} />
        </MenuItem>
      ))}
    </MenuList>
  );
}

function CurrencyRows({ filters, currencies }: Shared & { currencies: string[] }) {
  const toggle = (code: string) => {
    const next = currencies.includes(code)
      ? currencies.filter((c) => c !== code)
      : [...currencies, code];
    filters.set("currencies", { currencies: next });
  };
  return (
    <MenuList sx={{ py: 0.5, minWidth: 220 }}>
      {/* The icon carries the value everywhere else, but a MENU has to stay
          readable cold — you pick from a list of names, not of logos. */}
      {FILTER_CURRENCIES.map((c) => (
        <MenuItem key={c} onClick={() => toggle(c)} sx={{ gap: 1 }}>
          <Checkbox size="small" checked={currencies.includes(c)} sx={{ p: 0 }} />
          <CurrencyIcon code={c} size={20} />
          <span>{CURRENCY_LABEL[c] ?? c}</span>
        </MenuItem>
      ))}
    </MenuList>
  );
}

function SeatsToggle({
  filters,
  minSeats,
  onDone,
}: Shared & { minSeats: number; onDone?: () => void }) {
  return (
    <Box sx={{ p: 1 }}>
      <ToggleButtonGroup
        size="small"
        exclusive
        value={minSeats}
        onChange={(_e, v: number | null) => {
          if (!v) return;
          filters.set("minSeats", { minSeats: v });
          onDone?.();
        }}
      >
        {[1, 2, 3, 4, 5, 6].map((n) => (
          <ToggleButton key={n} value={n} sx={{ px: 1.25, textTransform: "none" }}>
            {n}+
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
    </Box>
  );
}

function NonstopSwitch({ filters, directOnly }: Shared & { directOnly: boolean }) {
  return (
    <FormControlLabel
      sx={{ ml: 0 }}
      control={
        <Switch
          size="small"
          checked={directOnly}
          onChange={(e) => filters.set("directOnly", { directOnly: e.target.checked })}
        />
      }
      label={<Typography variant="body2">Nonstop only</Typography>}
    />
  );
}

function PointLimitField({
  filters,
  pointLimit,
  onDone,
}: Shared & { pointLimit: number | null; onDone?: () => void }) {
  const [draft, setDraft] = useState(pointLimit == null ? "" : String(pointLimit));

  // Committed on Enter and on the button, never per keystroke: 5, 50 and 500 on
  // the way to 50,000 are not ceilings anybody chose, and each one would save.
  const commit = () => {
    const next = parsePointLimit(draft);
    if (next !== pointLimit) filters.set("pointLimit", { pointLimit: next });
    onDone?.();
  };

  return (
    <Box
      component="form"
      onSubmit={(e) => {
        e.preventDefault();
        commit();
      }}
      sx={{ p: 1.5, display: "flex", alignItems: "center", gap: 1 }}
    >
      <TextField
        type="number"
        size="small"
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="No limit"
        sx={{ width: 130 }}
        slotProps={{ htmlInput: { min: 0, step: 5000, "aria-label": "Point limit in miles" } }}
      />
      <Button type="submit" size="small" variant="contained">
        Apply
      </Button>
      <Button
        size="small"
        color="inherit"
        onClick={() => {
          setDraft("");
          if (pointLimit != null) filters.set("pointLimit", { pointLimit: null });
          onDone?.();
        }}
      >
        No limit
      </Button>
    </Box>
  );
}

/** The rungs the phone's ceiling picker offers. 25k is about the coarsest step
 *  that still lands on the numbers people actually hold, and the list stops
 *  where award charts do rather than running on into the millions the Worker
 *  would accept. */
const POINT_LIMIT_STEPS = [25, 50, 75, 100, 125, 150, 175, 200, 250, 300].map((k) => k * 1000);

/**
 * The points ceiling on a phone: a picker, not a number field.
 *
 * The field is the better control on a desktop — a ceiling is whatever is in the
 * account, and 87,500 is as real an answer as 100,000. On a phone it summons the
 * keyboard over the sheet you are still reading, and it summons it on OPEN,
 * which is what made this the one filter you had to dismiss before you could use
 * the other four. Rungs cost precision that a phone was never the place for.
 *
 * A stored value off the rungs keeps its own option rather than being rounded or
 * blanked — a Select with a value absent from its options renders empty and
 * warns, and this one would be silently discarding a ceiling set at a desk.
 */
function PointLimitSelect({ filters, pointLimit }: Shared & { pointLimit: number | null }) {
  const steps = POINT_LIMIT_STEPS.includes(pointLimit ?? 0)
    ? POINT_LIMIT_STEPS
    : [...POINT_LIMIT_STEPS, pointLimit].filter((n): n is number => n != null).sort((a, b) => a - b);

  return (
    <TextField
      select
      size="small"
      fullWidth
      // 0 is the wire's "no ceiling" too — `clampPointLimit` reads it as null —
      // so the empty option can carry a real value and the Select never has to
      // hold "".
      value={pointLimit ?? 0}
      onChange={(e) =>
        filters.set("pointLimit", { pointLimit: Number(e.target.value) || null })
      }
      slotProps={{ htmlInput: { "aria-label": "Point limit in miles" } }}
    >
      <MenuItem value={0}>No limit</MenuItem>
      {steps.map((n) => (
        <MenuItem key={n} value={n}>
          {miles(n)}
        </MenuItem>
      ))}
    </TextField>
  );
}
