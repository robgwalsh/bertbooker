import { useQuery } from "@tanstack/react-query";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import MarkEmailReadRoundedIcon from "@mui/icons-material/MarkEmailReadRounded";
import { api } from "../../../api/index";
import { SectionHeader } from "../../SectionHeader";
import { DeliveriesTable } from "./DeliveriesTable";

/**
 * The last fifteen digests the app tried to send.
 *
 * Including the ones that never went out — a `failed` or `skipped` row here is
 * the only trace a dropped digest leaves anywhere.
 */
export function SentMailPanel() {
  const deliveries = useQuery({
    queryKey: ["alert-deliveries"],
    queryFn: () => api.alertDeliveries(15),
  });

  return (
    <Box>
      <SectionHeader
        title="Sent mail"
        icon={<MarkEmailReadRoundedIcon sx={{ color: "secondary.main" }} />}
      />
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Every digest the app has tried to send, newest first
      </Typography>
      <DeliveriesTable deliveries={deliveries.data ?? []} />
    </Box>
  );
}
