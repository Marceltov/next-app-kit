// next-app-kit/signin: Better Auth set up as the Sign-in and Better Auth conventions say, under the app's env prefix (accounts.ts), who is
// asking (person.ts), the sign-in mail in the app's words (mail.ts), and what the sign-in routes and pages need (routes.ts).
export {
  ACCESS_TOKEN_SECONDS,
  API_TOKEN_DAYS,
  API_TOKEN_RESOURCE,
  emailAllowed,
  openAuth,
  safeNext,
  signInFromEnv,
  signInMethods,
  type Auth,
  type OpenAuthOptions,
  type Provider,
  type Refusal,
  type SignInSettings,
} from "./accounts.js";
export { mailLanguage, renderMail, smtpMailer, type MailTexts, type Mailer, type SignInMail, type Smtp } from "./mail.js";
export { allowedPerson, personOf, stillAllowed, type Person } from "./person.js";
export { apiResourceMetadataRoute, authServerMetadataRoute, clientNameFor, openIdConfigRoute, refusedSignIn, type RefusedSignIn } from "./routes.js";
