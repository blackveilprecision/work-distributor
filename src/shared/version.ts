// The release version, from package.json; bun build --compile embeds it. A release tag is v<this>.
import pkg from "../../package.json";
export const VERSION: string = pkg.version;
