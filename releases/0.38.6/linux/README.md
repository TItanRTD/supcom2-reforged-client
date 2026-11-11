# Supreme Commander 2 Reforged 0.38.6 for Linux

This preview includes a native x86-64 desktop client. The game runs through
the desktop version of Steam and Proton. Install the Windows game through
Steam and launch it once with Proton before setting up Reforged. This package
contains the launcher and Reforged assets. Steam supplies the game files.

1. Run `bash SupCom2-Reforged-0.38.6-Linux-x86_64-Setup.run` as your regular
   user. Open **Supreme Commander 2 Reforged** from your application menu.
   The installer checks its payload, installs the client and creates the menu
   entry. It does not need sudo.
2. Check the detected installation on the sign-in screen or under
   **Profile → Settings**. For offline skirmish you can stay signed out.
   If needed, select `bin/SupremeCommander2.exe` from your Steam library.
3. Under **Linux Steam setup**, click **Copy Steam launch option**. Paste it
   into the game's **Properties → General → Launch Options** in Steam.
   Keep a copy of any existing custom launch options before replacing them.
4. Click **Launch Reforged** and open **Skirmish** in the game. Use **Replays**
   in the launcher to open a local replay. After an update, copy and paste
   the Steam launch option again.

The preview targets desktop Steam on x86-64 Linux. It supports game discovery,
local Reforged Balance skirmish, replay launch and direct Steam lobby requests.
Ranked matchmaking, automatic lobby tracking, Flatpak Steam and Steam Deck
Gaming Mode are outside this preview. You can remove the Steam launch option
to return to launching directly through Steam.
