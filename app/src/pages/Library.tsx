import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  Paper,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tabs,
  Tooltip,
  Typography,
} from "@mui/material";
import { alpha, useTheme, type Theme } from "@mui/material/styles";
import FlightRoundedIcon from "@mui/icons-material/FlightRounded";
import FlightTakeoffRoundedIcon from "@mui/icons-material/FlightTakeoffRounded";
import HotelRoundedIcon from "@mui/icons-material/HotelRounded";
import AccountBalanceWalletRoundedIcon from "@mui/icons-material/AccountBalanceWalletRounded";
import PublicRoundedIcon from "@mui/icons-material/PublicRounded";
import { api, type AirlineInfo, type CurrencyInfo, type ProgramInfo } from "../api";
import {
  CURRENCY_COLOR,
  CURRENCY_LABEL,
  NEUTRAL_COLOR,
  resolveColor,
  CurrencyIcon,
  faviconUrl,
  flagEmoji,
  sortCurrencies,
  PagePad,
  STICKY_NAV_TOP,
  useIsNarrow,
} from "../ui";
import { readable } from "../theme";
import { Airports } from "./Airports";

const ALLIANCE: Record<string, { label: string; color: string }> = {
  star: { label: "Star Alliance", color: "#6ea8fe" },
  oneworld: { label: "oneworld", color: "#f5c451" },
  skyteam: { label: "SkyTeam", color: "#c084fc" },
};

// Brand domains for favicon lookup (presentation-only; keyed by our program/
// currency codes). Missing codes fall back to the monogram / color dot.
const PROGRAM_DOMAIN: Record<string, string> = {
  aeroplan: "aircanada.com",
  lifemiles: "lifemiles.com",
  turkish: "turkishairlines.com",
  united: "united.com",
  eva: "evaair.com",
  ana: "ana.co.jp",
  singapore: "singaporeair.com",
  flyingblue: "flyingblue.com",
  virginatlantic: "virginatlantic.com",
  avios: "britishairways.com",
  aadvantage: "aa.com",
  alaska: "alaskaair.com",
  cathay: "cathaypacific.com",
  jetblue: "jetblue.com",
  qantas: "qantas.com",
  emirates: "emirates.com",
  etihad: "etihad.com",
  hyatt: "hyatt.com",
  marriott: "marriott.com",
  ihg: "ihg.com",
  accor: "accor.com",
  wyndham: "wyndhamhotels.com",
  choice: "choicehotels.com",
};

// (The currencies' own issuer domains live in `ui.tsx` beside `CurrencyIcon`,
// which every page draws them through — this file is no longer their only reader.)

// Same idea, keyed by IATA carrier code (see AIRLINE_SEEDS in core).
const AIRLINE_DOMAIN: Record<string, string> = {
  AC: "aircanada.com",
  UA: "united.com",
  LH: "lufthansa.com",
  LX: "swiss.com",
  OS: "austrian.com",
  SN: "brusselsairlines.com",
  TK: "turkishairlines.com",
  SQ: "singaporeair.com",
  NH: "ana.co.jp",
  OZ: "flyasiana.com",
  AI: "airindia.com",
  AV: "avianca.com",
  CM: "copaair.com",
  BR: "evaair.com",
  TP: "flytap.com",
  TG: "thaiairways.com",
  ET: "ethiopianairlines.com",
  MS: "egyptair.com",
  LO: "lot.com",
  A3: "aegeanair.com",
  NZ: "airnewzealand.com",
  CA: "airchina.com",
  AA: "aa.com",
  BA: "britishairways.com",
  IB: "iberia.com",
  QR: "qatarairways.com",
  CX: "cathaypacific.com",
  JL: "jal.co.jp",
  AY: "finnair.com",
  QF: "qantas.com",
  MH: "malaysiaairlines.com",
  AS: "alaskaair.com",
  RJ: "rj.com",
  AT: "royalairmaroc.com",
  EI: "aerlingus.com",
  DL: "delta.com",
  AF: "airfrance.com",
  KL: "klm.com",
  KE: "koreanair.com",
  VS: "virginatlantic.com",
  AM: "aeromexico.com",
  AZ: "ita-airways.com",
  CI: "china-airlines.com",
  MU: "ceair.com",
  VN: "vietnamairlines.com",
  GA: "garuda-indonesia.com",
  SV: "saudia.com",
  KQ: "kenya-airways.com",
  SK: "flysas.com",
  EK: "emirates.com",
  EY: "etihad.com",
  B6: "jetblue.com",
  HA: "hawaiianairlines.com",
  VA: "virginaustralia.com",
  FJ: "fijiairways.com",
  JX: "starlux-airlines.com",
  DE: "condor.com",
};

// Alliance accent, with the "no alliance" fallback shared by programs and
// carriers. The fallbacks are palette ROLES rather than the old theme's indigo
// and teal, so an unaligned carrier and a hotel program pick up whichever theme
// is on instead of staying two colours nothing else on the page uses.
function allianceColor(alliance: string | null, theme: Theme): string {
  const a = alliance ? ALLIANCE[alliance] : undefined;
  return readable(a ? a.color : theme.palette.secondary.main, theme);
}

// Brand-ish accent per program: alliance color for airlines, the theme's
// secondary for hotels.
function tileColor(p: ProgramInfo, theme: Theme): string {
  return p.kind === "hotel" ? theme.palette.secondary.main : allianceColor(p.alliance, theme);
}

// Placeholder "logo" until real assets exist: initials from the program name.
function monogram(name: string): string {
  const stop = new Set(["of", "the", "and", "&"]);
  const words = name
    .replace(/[/()]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !stop.has(w.toLowerCase()));
  const [first, second] = words;
  if (!first) return name.slice(0, 2).toUpperCase();
  if (!second) return first.slice(0, 2).toUpperCase();
  return (first[0]! + second[0]!).toUpperCase();
}

// A single square brand tile: real favicon on a light chip, monogram fallback
// when there's no known domain or the icon fails to load.
function BrandTile({
  name,
  domain,
  color,
  size = 46,
}: {
  name: string;
  domain?: string;
  color: string;
  size?: number;
}) {
  const [broken, setBroken] = useState(false);
  const showIcon = Boolean(domain) && !broken;
  const img = Math.round(size * 0.6);
  return (
    <Box
      title={name}
      sx={{
        width: size,
        height: size,
        borderRadius: 1.5,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        // The favicon keeps its white paper in every theme (see `CurrencyIcon`);
        // only the edge follows, so a white tile doesn't dissolve into a light
        // theme's near-white page.
        bgcolor: showIcon ? "#ffffff" : alpha(color, 0.18),
        border: (t) =>
          `1px solid ${showIcon ? t.palette.divider : alpha(color, 0.4)}`,
        color,
        fontWeight: 700,
        fontSize: Math.round(size * 0.32),
        letterSpacing: "0.02em",
      }}
    >
      {showIcon ? (
        <Box
          component="img"
          src={faviconUrl(domain!)}
          alt=""
          loading="lazy"
          onError={() => setBroken(true)}
          sx={{ width: img, height: img, objectFit: "contain" }}
        />
      ) : (
        monogram(name)
      )}
    </Box>
  );
}

function ProgramTile({ program, size }: { program: ProgramInfo; size?: number }) {
  const theme = useTheme();
  return (
    <BrandTile
      name={program.name}
      domain={PROGRAM_DOMAIN[program.code]}
      color={tileColor(program, theme)}
      size={size}
    />
  );
}

// Arrange tiles so the bounding box is as square as possible: ceil(sqrt(n)) cols.
function ProgramTileGrid({ programs }: { programs: ProgramInfo[] }) {
  const cols = Math.max(1, Math.ceil(Math.sqrt(programs.length)));
  return (
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns: `repeat(${cols}, auto)`,
        gap: 0.75,
        p: 0.25,
      }}
    >
      {programs.map((p) => (
        <ProgramTile key={p.code} program={p} />
      ))}
    </Box>
  );
}

function AllianceChip({ alliance }: { alliance: string | null }) {
  const theme = useTheme();
  const a = alliance ? ALLIANCE[alliance] : undefined;
  if (!a) return null;
  // oneworld's gold is the case this exists for: unreadable as chip text on any
  // light theme, unchanged on every dark one.
  const color = readable(a.color, theme);
  return (
    <Chip
      size="small"
      label={a.label}
      sx={{
        color,
        bgcolor: alpha(color, 0.14),
        border: `1px solid ${alpha(color, 0.35)}`,
      }}
    />
  );
}

/** Which currencies transfer into a program, as issuer marks.
 *
 *  The ratio is the one thing the mark can't say, and it is the reason this isn't
 *  just `BookableCurrencies`: a 1:1 transfer is the norm and stays silent, while
 *  anything else is printed beside the icon — a 1.5:1 partner priced as if it
 *  were 1:1 is a wrong answer, not a missing detail. */
function TransferCurrencies({ partners }: { partners: ProgramInfo["transfer_partners"] }) {
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

function SectionHeader({
  title,
  icon,
  count,
}: {
  title: string;
  icon: React.ReactNode;
  count?: number;
}) {
  return (
    <Stack direction="row" spacing={1.5} sx={{ mb: 2, alignItems: "center" }}>
      {icon}
      <Typography variant="h5">{title}</Typography>
      {count !== undefined && (
        <Chip
          size="small"
          label={count}
          sx={{ bgcolor: (t) => t.spec.accentMuted, color: "secondary.main" }}
        />
      )}
    </Stack>
  );
}

function CurrenciesSection({
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
              <TableCell align="right">Portal rate</TableCell>
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
                  <TableCell align="right" sx={{ whiteSpace: "nowrap" }}>
                    {/* What a cash fare costs in this currency's own travel
                        portal. This is the rate the app converts at — edit it in
                        shared/src/data/programs.ts, and every stored find
                        re-prices without re-gathering it. */}
                    {cur.portalCentsPerPoint ? (
                      <Tooltip title={cur.portalName ?? "Travel portal"}>
                        <Typography
                          component="span"
                          variant="body2"
                          sx={{ fontVariantNumeric: "tabular-nums", cursor: "help" }}
                        >
                          {cur.portalCentsPerPoint}¢/pt
                        </Typography>
                      </Tooltip>
                    ) : (
                      <Typography component="span" variant="body2" color="text.disabled">
                        —
                      </Typography>
                    )}
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

// "Avios (BA / Iberia / …)" -> "Avios". The parenthetical is useful in the
// programs table and pure noise in a wrapped row of chips.
function shortProgramName(name: string): string {
  return name.replace(/\s*\(.*\)\s*$/, "").trim();
}

// Wallet order for the currency marks, so every row reads left-to-right the same.
const CURRENCY_ORDER = Object.keys(CURRENCY_LABEL);

function CurrencyIcons({ codes }: { codes: string[] }) {
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

/** Carriers, and which miles buy a seat on them. The program codes come from
 *  core's seed alliance table (`/api/airlines`); their names, colors and transfer
 *  partners are joined from the D1 programs table, so a program deactivated
 *  there disappears from these rows too. */
function AirlinesSection({
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

function Section({
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

/** Left-hand nav for the library. Each entry owns the whole content area, so a
 *  wide surface (the airline table, the airports map) gets the full width of the
 *  shell instead of competing with the other sections for vertical space. */
const LIBRARY_TABS = [
  { key: "currencies", label: "Currencies", icon: <AccountBalanceWalletRoundedIcon /> },
  {
    key: "airline-programs",
    label: "Airline programs",
    icon: <FlightRoundedIcon sx={{ transform: "rotate(45deg)" }} />,
  },
  { key: "airlines", label: "Airlines", icon: <FlightTakeoffRoundedIcon /> },
  { key: "hotels", label: "Hotel programs", icon: <HotelRoundedIcon /> },
  { key: "airports", label: "Airports", icon: <PublicRoundedIcon /> },
] as const;

export function Library() {
  const [tab, setTab] = useState(0);
  // The tab column becomes a scrollable strip below `md` — see the `Tabs` below.
  const narrow = useIsNarrow();
  const programsQ = useQuery({ queryKey: ["programs"], queryFn: api.programs });
  const currenciesQ = useQuery({ queryKey: ["currencies"], queryFn: api.currencies });
  // Static reference data — fetch once per session, like the airport geo set.
  const airlinesQ = useQuery({
    queryKey: ["airlines"],
    queryFn: api.airlines,
    staleTime: Infinity,
  });

  const active = LIBRARY_TABS[tab]?.key ?? "currencies";

  // Airports renders even when the programs/currencies fetch is still in flight
  // or has failed — it shares no data with them. Only the program-backed panes
  // wait.
  function panel() {
    if (active === "airports") return <Airports />;
    if (programsQ.isLoading || currenciesQ.isLoading)
      return (
        <Stack sx={{ py: 8, alignItems: "center" }}>
          <CircularProgress />
        </Stack>
      );
    if (programsQ.error)
      return <Alert severity="error">Failed to load programs: {String(programsQ.error)}</Alert>;
    if (!programsQ.data) return null;

    const programs = programsQ.data;
    switch (active) {
      case "currencies":
        return <CurrenciesSection currencies={currenciesQ.data ?? []} programs={programs} />;
      case "airline-programs":
        return (
          <Section
            title="Airline programs"
            icon={<FlightRoundedIcon sx={{ color: "secondary.main", transform: "rotate(45deg)" }} />}
            programs={programs.filter((p) => p.kind === "airline")}
          />
        );
      case "airlines":
        return <AirlinesSection airlines={airlinesQ.data ?? []} programs={programs} />;
      case "hotels":
        return (
          <Section
            title="Hotel programs"
            icon={<HotelRoundedIcon sx={{ color: "secondary.main" }} />}
            programs={programs.filter((p) => p.kind === "hotel")}
          />
        );
      default:
        return null;
    }
  }

  // A document, not a workbench — so unlike the Routes page it asks the shell
  // for the page margin and the scroll container it used to get for free.
  return (
    <PagePad>
    <Stack
      direction={{ xs: "column", md: "row" }}
      spacing={{ xs: 2, md: 3 }}
      sx={{ alignItems: { md: "flex-start" } }}
    >
      {/* A column beside the content from `md` up; a scrollable strip above it
          below that. This follows the seam `STICKY_NAV_TOP` already names — "a
          nav is only pinned from `md` up" — to its conclusion: under that width
          it should not be a COLUMN either. A 190px rail on a 390px screen left
          about 150px for the pane it was navigating.

          One `Tabs` with a branched `orientation`, never two hidden by `sx`:
          `orientation` and `variant` are props rather than styles, and two tab
          lists would put two `role="tab"` nodes named "Airports" in the document
          — which is both wrong for a screen reader and ambiguous for the UI
          harness's landmarks. */}
      <Tabs
        orientation={narrow ? "horizontal" : "vertical"}
        variant={narrow ? "scrollable" : "standard"}
        scrollButtons="auto"
        allowScrollButtonsMobile
        value={tab}
        onChange={(_, v: number) => setTab(v)}
        sx={{
          flexShrink: 0,
          minWidth: { md: 190 },
          maxWidth: "100%",
          // Pinned at its own resting position, the same as the Routes rail —
          // the content pane scrolls past a tab column that never moves.
          position: { md: "sticky" },
          top: { md: STICKY_NAV_TOP },
          // The rule follows the orientation: it is the edge this nav shares
          // with the pane, so it is on the right of a column and under a strip.
          borderRight: { md: 1 },
          borderBottom: { xs: 1, md: 0 },
          borderColor: "divider",
          "& .MuiTab-root": {
            minHeight: 44,
            gap: 1.25,
            // Left-aligned only as a column. A horizontal strip centres its own
            // labels, and forcing them left just makes the icons ragged.
            alignItems: { md: "flex-start" },
            justifyContent: { md: "flex-start" },
            textAlign: { md: "left" },
          },
        }}
      >
        {LIBRARY_TABS.map((t) => (
          <Tab key={t.key} label={t.label} icon={t.icon} iconPosition="start" />
        ))}
      </Tabs>

      {/* minWidth: 0 keeps the wide tables and the map from forcing the flex row
          (and with it the whole page) into a horizontal scroll. */}
      <Box sx={{ flex: 1, minWidth: 0 }}>{panel()}</Box>
    </Stack>
    </PagePad>
  );
}
