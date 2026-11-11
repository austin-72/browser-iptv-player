# Security

## Reporting a vulnerability

Please report it privately, not in a public issue: on the repository's **Security** tab, choose **Report a
vulnerability**. That opens a private report only the maintainer sees.

It helps to say:

- what you can do that you shouldn't be able to (and as whom: not signed in, signed in with the site password, a
  profile, a kids profile, the admin);
- the steps or a request that shows it, and the version (Admin → Overview, or `package.json`);
- whether it needs anything unusual: a provider you control, a crafted list or guide file, a link someone has to open.

You'll get an answer as soon as the maintainer has looked at it. Please give a fix a reasonable time before writing
about it publicly.

## What's supported

The latest version on the main branch. There are no older release lines.

## What the app assumes

It's made for a household: everyone who knows the site password is let in, profiles and PINs keep them apart, and one
profile is the admin. Worth knowing when judging a report:

- **Providers aren't trusted.** Lists, guides, titles, pictures and streams come from them; anything of theirs that
  ends up in a page is escaped, and a Content-Security-Policy stops script that didn't come from the server itself.
- **The admin is trusted** with the server: the admin can add media folders, restore a backup and install an update.
- **The site password is the outer door.** Until it's changed from the default, the server only answers on local
  addresses. Outside the home it belongs behind https (see the README's Security section).

The README's [Security](README.md#security) section says what's in place.
