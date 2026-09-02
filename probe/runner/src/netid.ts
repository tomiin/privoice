// Set the SDK network id to PREVIEW before building providers.
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
export function initializeNetwork() {
  setNetworkId("preview" as any);
}
