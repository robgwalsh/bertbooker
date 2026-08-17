import { Box, Stack, Tooltip, Typography } from "@mui/material";
import { alpha, type Theme } from "@mui/material/styles";
import FlightRoundedIcon from "@mui/icons-material/FlightRounded";
import { airportLine } from "./labels";
import { ROUTE_DIAGRAM_WIDTH } from "./constants";
import { parseCodes } from "../../lib/routeShape";
import type { AirportName, TrackedRoute } from "../../api";

/**
 * One airport of a route's spec, as a pill.
 *
 * A pill each rather than the rail's `SEA/PDX` string, because in the header
 * these are the things you PICKED — separable and individually nameable. The
 * slash form stays in the rail, where the route is a label rather than a spec.
 */
/**
 * One airport in the header diagram: the CODE as plain text, and nothing else.
 *
 * A tinted chip with the full airport name and city/country stacked
 * underneath would make the header the busiest thing on the page for
 * information most glances do not need: you know what PIT is, and when you
 * don't, the tooltip still says it in full. So the lookup is not wasted, only
 * quieter — `airportLine` remains the title, and the rail keeps its one-line
 * city subtitle for telling two similar routes apart.
 *
 * The codes carry the emphasis themselves (18px, bold, tracked out), so the
 * chrome was doing nothing the type was not already doing.
 */
function AirportPill({ code, names }: { code: string; names: Map<string, AirportName> }) {
  const airport = names.get(code);

  return (
    <Tooltip title={airportLine(airport, code)} placement="top">
      <Box
        component="span"
        sx={{
          display: "inline-block",
          textAlign: "center",
          fontWeight: 700,
          fontSize: 18,
          letterSpacing: 1,
          lineHeight: 1.35,
          // `inherit`, not `help`: in the header these sit inside a clickable
          // side, and a help cursor over a button says the wrong thing about
          // what a click will do. In the rail there is nothing to inherit from
          // and the default arrow is right.
          cursor: "inherit",
          whiteSpace: "nowrap",
          color: "text.primary",
        }}
      >
        {code}
      </Box>
    </Tooltip>
  );
}

/** The line between two sides of the diagram. Decorative, and deliberately not
 *  proportional to anything — this is a topology sketch, the same rule
 *  `ItineraryCard`'s stop bar follows.
 *
 *  Fixed width, NOT `flex: 1`: the diagram sits in a row that stretches to the
 *  card, so a growing connector drags the destination to the far edge and puts a
 *  metre of empty rule through the middle of the header. */
/** The line between the two sides of the header diagram.
 *
 *  A round trip gets a SECOND plane pointing back, because the route genuinely
 *  watches both directions — one plane would draw a one-way route the app is not
 *  monitoring. Mirrored rather than a `⇄` glyph so it stays the same visual
 *  language as the one-way case. */
function Connector({ roundTrip }: { roundTrip?: boolean }) {
  // One rail width for both cases: a width that differed between round-trip
  // and one-way would make the connector — and therefore the whole diagram —
  // narrower for one case than the other, so selecting a different route in
  // the rail would shift everything to its right. The two-plane stack is the
  // same width as the one-plane one, so a constant rail is a constant connector.
  const rail = {
    width: 30,
    height: 2,
    borderRadius: 1,
    background: (t: Theme) =>
      `linear-gradient(90deg, ${alpha(t.palette.secondary.main, 0.45)}, ${alpha(
        t.spec.success,
        0.45,
      )})`,
  };
  const plane = { fontSize: 14, color: "text.disabled" };
  return (
    <Stack
      direction="row"
      sx={{ alignItems: "center", gap: 0.5, flexShrink: 0 }}
      aria-label={roundTrip ? "round trip" : "one way"}
    >
      <Box sx={rail} />
      <Stack sx={{ alignItems: "center", gap: 0.1 }}>
        <FlightRoundedIcon sx={{ ...plane, transform: "rotate(90deg)" }} />
        {roundTrip && <FlightRoundedIcon sx={{ ...plane, transform: "rotate(-90deg)" }} />}
      </Stack>
      <Box sx={rail} />
    </Stack>
  );
}

/**
 * The route's shape, drawn: origins → destinations.
 *
 * A pill per airport rather than one `SEA/PDX → NRT/HND` string, so each airport
 * the route watches is separately readable and separately nameable.
 */
export function RouteDiagram({
  route,
  names,
  onEditSide,
}: {
  route: TrackedRoute;
  names: Map<string, AirportName>;
  /** Each side of the diagram is one field of the route form, so each side is a
   *  shortcut to it. Absent in the rail, where a click selects the route. */
  onEditSide?: (side: "origins" | "destinations") => void;
}) {
  const origins = parseCodes(route.origins, route.origin);
  const destinations = parseCodes(route.destinations, route.destination);

  // No tooltip on the side itself: the pills already carry the airports' full
  // names, and a second tooltip over the top of them would replace the answer
  // you wanted with an instruction you didn't ask for. The pointer and the
  // hover ground say it is clickable instead.
  const side = (codes: string[], which: "origins" | "destinations") => (
    <Stack
      direction="row"
      spacing={0.5}
      useFlexGap
      role={onEditSide ? "button" : undefined}
      tabIndex={onEditSide ? 0 : undefined}
      aria-label={onEditSide ? `Edit ${which}` : undefined}
      onClick={onEditSide ? () => onEditSide(which) : undefined}
      onKeyDown={
        onEditSide
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onEditSide(which);
              }
            }
          : undefined
      }
      sx={{
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "center",
        ...(onEditSide && {
          cursor: "pointer",
          px: 0.5,
          mx: -0.5,
          transition: "background-color 120ms",
          "&:hover": { bgcolor: (t: Theme) => t.spec.hover },
          "&:focus-visible": {
            outline: "1px solid",
            outlineColor: (t: Theme) => t.spec.indicator,
            outlineOffset: 0,
          },
        }),
      }}
    >
      {codes.map((c) => (
        <AirportPill key={c} code={c} names={names} />
      ))}
    </Stack>
  );

  // The connector is bundled with the side it LEADS TO, in a nowrap group. On a
  // narrow screen the diagram then breaks between groups; left as loose siblings
  // it breaks after the connector instead, leaving a rule pointing at nothing and
  // the destination orphaned on the next line.
  return (
    <Stack
      direction="row"
      spacing={1.25}
      useFlexGap
      sx={{ alignItems: "center", flexWrap: "wrap", minWidth: 0 }}
    >
      {side(origins, "origins")}
      <Stack direction="row" spacing={1.25} sx={{ alignItems: "center", flexWrap: "nowrap" }}>
        <Connector roundTrip={route.round_trip === 1} />
        {side(destinations, "destinations")}
      </Stack>
    </Stack>
  );
}
