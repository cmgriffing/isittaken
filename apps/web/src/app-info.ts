import pkg from "../package.json";

/** The web app's own version, supplied to core's registry fetch for the User-Agent. */
export const APP_VERSION: string = pkg.version;
