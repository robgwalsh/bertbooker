// Airport type → label + accent color. Shared by the Airports table chips and the
// airport map's dot colors/legend so the palette stays in one place.
export const TYPE_LABEL: Record<string, { label: string; color: string }> = {
  large_airport: { label: "Large", color: "#7c8cff" },
  medium_airport: { label: "Medium", color: "#38e0c8" },
  small_airport: { label: "Small", color: "#9aa3bd" },
  heliport: { label: "Heliport", color: "#f5c451" },
  seaplane_base: { label: "Seaplane", color: "#c084fc" },
  balloonport: { label: "Balloon", color: "#f5c451" },
};
