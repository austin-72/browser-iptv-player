# Channels, the TV guide, your lists and parental locks

[← Back to the README](../README.md)

Everything here is stored on the server in `data/channels.json` (admin changes) and in each profile's settings (your lists), so it survives restarts, list refreshes and updates.

## Admin → Channels

Search by name or number, and filter by list, category, type (TV or radio) and "Changed", "Hidden", "Locked" or "No guide".

- **Edit** a channel to rename it, give it a number, move it to another category, set its logo (a web address, or upload a picture; it's shrunk to 256 px and kept on the server), choose its TV guide channel, move its guide times, lock it or hide it. **Undo all changes** puts it back to the provider's version.
- **Reorder** within a category with the arrow buttons, or by dragging the rows on a computer.
- **Select several** with the tick boxes (hold Shift to tick a whole run) to hide or show them, move them to another category, number them from a starting number, lock or unlock them, or undo their changes.
- Changes are keyed to the channel, so they stay put when the provider's list refreshes. If a provider renames a channel's address, the change follows it. They show on every device straight away, and appear in the playlist and guide exports (names, numbers, categories, logos and guide times).

## TV guide matching and time offsets

- Each channel's guide is matched automatically. To choose one yourself, open **Edit → Pick a guide channel**, search across all your guides and see what's on now and next before you pick. **Match automatically** goes back to the automatic match.
- **Time offset**: move a channel's guide times in half-hour steps (in the channel's Edit window), or a whole guide's times (Admin → TV guides, next to each guide). The two add up.
- Only the channels you actually use are kept in memory, as before; offsets are applied as each guide is read, so they cost nothing extra.

## Placeholder listings

Channels with no guide data show hour-long blocks named after the channel (for event channels, the event name), drawn in a lighter dashed style so they're clearly not real listings. They're made on the fly in the browser and never stored. Turn them off in **Admin → TV guides → Placeholder listings**.

## Your channel lists

Under **Live TV → Your lists** (or `#/mychannels`) each profile can:

- put their favourites in their own order;
- make their own lists ("Kids' channels", "Football"…), add channels by name or number, reorder (arrows or drag), rename and delete them;
- choose which list **Live TV** and **the TV guide** open on (or "where I was last time").

The lists appear in Live TV, the guide's channel picker, the channel list in the player and on the phone remote. Any channel page also has **Add to one of your lists**.

## Guide colours

Programmes are coloured by type: sport, film, news, kids, documentary, music and other, with a legend above the guide. The colour is an edge plus a light tint, readable in dark, light and high-contrast themes (high contrast uses the edge only). Untick **Colours** above the guide to turn them off for your profile.

## On later

**On later** (from Live TV, the guide and the home page row "On later today") lists the films and sport in the next 48 hours, by day and type, with sport grouped by league or competition. Tick News or Kids to add those. Tap the bell to set a reminder. A programme shown on several channels appears once, on a favourite channel when there is one.

## Parental locks

- In **Admin → Channels → Parental lock**, set a 4–8 digit PIN. Then lock single channels (Edit → Locked, or select several and **Lock**) or whole categories (choose the category and switch on **Lock this category**).
- Locked channels show a lock and "Locked" in place of what's on. Playing one asks for the PIN; it then unlocks locked channels on that device for 30 minutes. After 5 wrong PINs, the device has to wait 5 minutes.
- Kids profiles can't unlock.
- The server enforces it: locked items are sent without their stream addresses or listings, and playing one without unlocking is refused.
- Locked channels stay in the admin's playlist and guide exports.

## Limits

- A channel whose listings come from several guides with different offsets uses the first guide's offset.
- The editor covers TV and radio channels. The server also honours locks on films and series (episodes follow their series), but there's no screen to set those yet; a locked film's page asks for the PIN when you press Play.
- Placeholder blocks are named after the channel; the provider's event name is used only when the playlist gives one.
