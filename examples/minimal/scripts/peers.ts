// What an app's one unit test for its peers does (an app with Vitest writes `test("peers", () => checkPeers())`): the kit's peers installed
// here at the kit's exact versions, whatever .npmrc says about legacy-peer-deps.
import { checkPeers } from "next-app-kit/testing";

checkPeers();
console.log("peers: every peer at the kit's version");
