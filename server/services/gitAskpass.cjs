// Git invokes this fixed helper in an isolated import environment. Never echo a
// secret for an arbitrary challenge, or include challenges in diagnostics.
const fs = require("node:fs");
try {
  const value = JSON.parse(
    fs.readFileSync(process.env.STERRACODE_GIT_ASKPASS_FILE, "utf8"),
  );
  const prompt = process.argv[2] || "";
  if (value.type === "ssh") {
    if (
      prompt !== `Enter passphrase for key '${value.keyFile}': ` &&
      prompt !== `Enter passphrase for key '${value.keyFile}':`
    )
      process.exit(1);
    process.stdout.write(value.secret + "\n");
    process.exit(0);
  }
  const match = /^(Username|Password) for '(https:\/\/[^']+)':\s*$/.exec(
    prompt,
  );
  if (!match) process.exit(1);
  const url = new URL(match[2]);
  if (
    url.protocol !== "https:" ||
    url.host !== value.host ||
    url.password ||
    url.search ||
    url.hash ||
    (url.username && decodeURIComponent(url.username) !== value.username)
  )
    process.exit(1);
  process.stdout.write(
    (match[1] === "Username" ? value.username : value.secret) + "\n",
  );
} catch {
  process.exit(1);
}
