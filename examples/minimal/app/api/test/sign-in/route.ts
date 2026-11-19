import { testSignInRoute } from "next-app-kit/testing";
import { auth, PREFIX } from "@/backend/app";

// The end-to-end tests' way in: GET ?email=…&next=/. Exists only with MINIMAL_E2E=1 outside a production build; there, GET is undefined
// and this route has no handler.
export const GET = testSignInRoute(PREFIX, auth);
