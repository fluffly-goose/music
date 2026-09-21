# Testing

## Automated

```bash
npm test          # unit suite
npm run check     # Astro + TypeScript diagnostics
```

### What was verified in development

Development happened on Linux, with the app driven in **headless Chromium at a
393×852 iPhone viewport** (iOS user-agent, touch enabled) against a mocked
Supabase project serving real WAV audio and real PNG artwork.

Verified working end to end:

- Onboarding: validation, connection test, refusal of a service-role key
- A remembered connection restoring straight into the library
- Home, Library (all four tabs), Search, album, artist, playlist, Settings
- Artwork loading through batched signed URLs
- Tapping a track → audio actually decoding and playing
- Play, pause, next, previous, seek, shuffle, repeat
- **Audio continuing uninterrupted across a four-screen in-app navigation tour**
- A track finishing and auto-advancing to the next one
- Recovery from a dead/expired audio URL, resuming at the same position
- Queue sheet: listing, jumping, removing
- Track action sheet, playlist reorder/remove actions
- Theme switching and preference persistence across reloads
- Editing songs, albums and artists, including validation, cancelling, artwork
  replacement under a fresh key, and deletion with storage cleanup
- Adding music in-app: reading tags in the browser, the review step, uploading
  to Storage under owner-prefixed keys, reusing existing artists and albums,
  and warning about formats Safari cannot play

### What was NOT verified

Anything that requires real iOS hardware. Specifically:

- Lock-screen metadata and transport controls
- Playback continuing when the screen locks
- Behaviour when the PWA is backgrounded or the app is switched away from
- Whether iOS suspends audio after a long idle period
- Home Screen installation and the standalone launch experience
- Safe-area insets on a physical notched device
- The iOS file picker, and whether an upload survives the screen locking or the
  browser being backgrounded mid-transfer

The Media Session API is wired up and feature-detected, but **no claim is made
that background playback works on iOS until you confirm it below.**

---

## Manual iPhone checklist

Run this on the real device, over HTTPS.

### Setup
- [ ] Signing in is offered after connecting (not a silently empty library)
- [ ] **Settings → Sign in** works when connected but signed out
- [ ] Settings says "Connected — signed out" rather than just "Connected"
- [ ] Site loads in Safari on iPhone
- [ ] Onboarding screen is readable, inputs don't trigger zoom on focus
- [ ] **Test** reports tables and bucket correctly
- [ ] Pasting a service-role key is refused with an explanation
- [ ] **Connect** works, then sign-in succeeds
- [ ] Close Safari entirely, reopen → lands straight in the library

### Install as a PWA
- [ ] Share → Add to Home Screen shows the Resonance icon
- [ ] Launching from the Home Screen opens full-screen with no Safari chrome
- [ ] Status bar is readable against the dark background
- [ ] Content clears the notch and the home indicator

### Layout
- [ ] Tab bar sits above the home indicator, not under it
- [ ] Every control is comfortably tappable one-handed
- [ ] Nothing scrolls horizontally
- [ ] Artwork is sharp on the Retina display
- [ ] Album/playlist headers look right on a small screen

### Adding music (from the phone)
- [ ] **Library → +** opens the Add music screen
- [ ] Tapping the drop zone opens the iOS file picker
- [ ] Picking several files at once works
- [ ] Music saved in Files / iCloud Drive can be selected
- [ ] Track details and durations appear correctly in the review step
- [ ] Tracks are grouped under the right albums
- [ ] Uploading over cellular completes, and progress advances
- [ ] Uploaded tracks appear in Library straight away
- [ ] Embedded artwork shows up as the album cover
- [ ] Uploading the same files again reports them as already in the library
- [ ] Locking the screen mid-upload — does the upload survive or resume?
- [ ] A large file (30 MB+) uploads without the tab being killed

### Editing
- [ ] The **…** menu on a song offers *Edit details*
- [ ] The edit sheet can be dragged down to dismiss
- [ ] Cancelling discards changes
- [ ] Renaming a song, album and artist all stick after a reload
- [ ] Changing one song's artist moves only that song
- [ ] Changing an album's artist moves every song on it too — check the old
      artist's page is gone and the songs appear under the new one
- [ ] Moving a song into an album that does not exist yet creates it
- [ ] An artist left with nothing after a move disappears from Library → Artists
- [ ] Changing album artwork shows the new image (not a cached old one)
- [ ] The artist sheet warns how many albums and songs a rename affects
- [ ] Deleting a song removes it and frees the storage file
- [ ] Editing while signed out is refused with a clear message

### Playback
- [ ] Tapping a track starts audio within a second or two
- [ ] Mini player appears and shows the right track
- [ ] Mini player expands into Now Playing (tap and swipe up)
- [ ] Swipe down dismisses Now Playing
- [ ] Play/pause, next, previous all work
- [ ] Scrubbing is smooth and lands where you dropped it
- [ ] Shuffle and repeat behave as expected
- [ ] Queue sheet lists what's coming and jumping works
- [ ] Playback keeps going while moving between tabs
- [ ] A track ending advances to the next one
- [ ] Reaching the end of a queue stops cleanly (no error)

### iOS-specific — the important ones
- [ ] **Lock the screen mid-song — does audio keep playing?**
- [ ] **Do the lock screen / Control Center show the title, artist and artwork?**
- [ ] **Do the lock-screen play/pause/skip buttons work?**
- [ ] Does audio survive switching to another app and back?
- [ ] Does it survive ~5 minutes locked?
- [ ] Does a phone call interrupt and then resume correctly?
- [ ] Do the hardware volume buttons work (the in-app slider is hidden by design)?

Record whatever you find here — especially the lock-screen items, since those
are the ones that can't be verified without the device.

### Network conditions
- [ ] Turn on Airplane Mode mid-song → a clear error, not a blank screen
- [ ] Reconnect → playback can be resumed
- [ ] On slow cellular, artwork and metadata still load in a sensible order
- [ ] Leave a track playing for over an hour → signed URL refresh is invisible

### Error handling
- [ ] Wrong project URL → clear message
- [ ] Right URL, wrong key → clear message
- [ ] Tables missing → tells you to run the migrations
- [ ] Wrong bucket name → tells you the bucket is missing
- [ ] Signed out → prompted to sign in, not left with a blank library
- [ ] Empty library → helpful empty state, not a blank screen
- [ ] A track whose file is missing from Storage → clear error, app stays usable

### Settings
- [ ] Connection status and library counts are accurate
- [ ] Theme switching works and survives a reload
- [ ] Shuffle/repeat preferences survive a reload
- [ ] *Disconnect and clear saved settings* returns you to onboarding
- [ ] After clearing, reopening the app shows onboarding (nothing left behind)
