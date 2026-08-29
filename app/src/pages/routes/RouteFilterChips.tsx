import { useRef, useState } from "react";
import {
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
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
import { BookableCurrencies, CabinChip, CurrencyIcon } from "../../components/brand";
import { CURRENCY_LABEL } from "../../lib/currencies";
import { miles } from "../../lib/format";
import { parseCodeList } from "../../lib/routeShape";
import { useIsPhone } from "../../hooks/useBreakpoints";
import { CABIN_OPTIONS, FILTER_CURRENCIES } from "./constants";
import { MUTED_CHIP_SX, SpecValue } from "./SpecValue";
import { parsePointLimit } from "./form";
import { useRouteFilterPatch, type FilterField } from "./useRouteFilterPatch";
import type { TrackedRoute } from "../../api";

/**
 * A route's READ FILTERS, edited where they are stated.
 *
 * These five decide what the route's pane SHOWS, and nothing else. Gathering is
 * wide and unfiltered — every cabin, every program, connecting and nonstop, at
 * any price is fetched, stored and claims coverage — so a filter here only ever
 * hides rows that are already in D1. Narrowing is one click and widening back is
 * one click; neither spends a metered call and neither needs a search. That is
 * the whole reason they are chips instead of a dialog: the settings that cost
 * nothing should be the ones that are easiest to reach, which is exactly
 * backwards from where they used to live.
 *
 * The rail states some of the same facts and deliberately does NOT do this —
 * `RouteFilters` shows a chip only when it constrains, because there you are
 * choosing between routes and an "Any cabin" chip on each of eight is eight
 * chips of nothing. Muted always-visible chips earn their width only on the one
 * route you have open.
 *
 * EVERY chip is rendered, set or not, because an unset filter you cannot see is
 * one you cannot turn on. Unset chips are muted and compact; a set one is full
 * size. The difference is the point — a set filter is a fact about this route,
 * an unset one is an offer.
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
      >
        {(close) => (
          <Stack sx={{ p: 1.5, gap: 1.5, minWidth: 260 }}>
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
              <PointLimitField {...shared} pointLimit={pointLimit} onDone={close} />
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
        // The chip's own content is `BookableCurrencies`, and each icon inside it
        // builds its own tooltip naming the card. A second tooltip out here would
        // fire with them — see the rule in `brand.tsx`.
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

      {/* The one filter with no popover: two states, so the chip IS the control.
          A popover holding a single switch would be a click to reach a click. */}
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
 *
 * A `Popover` rather than a `Menu`: three of the five bodies are not lists — a
 * boolean, a toggle group and a number field — and `Menu`'s typeahead eats the
 * keystrokes the number field needs.
 *
 * `children` takes the close function because two of the bodies are single-shot:
 * picking a seat count or clearing the ceiling answers the question, and leaving
 * the surface open afterwards makes you dismiss something you are done with.
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
      {children && (
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
      )}
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
