Unicode true
Name "Supreme Commander 2 Reforged 0.38.5"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\Supreme Commander 2 Reforged"
RequestExecutionLevel user
SetCompressor /SOLID bzip2
ShowInstDetails show
ShowUninstDetails show
VIProductVersion "0.38.5.0"
VIAddVersionKey "ProductName" "Supreme Commander 2 Reforged"
VIAddVersionKey "FileDescription" "Supreme Commander 2 Reforged Setup"
VIAddVersionKey "FileVersion" "0.38.5"
VIAddVersionKey "ProductVersion" "0.38.5"
VIAddVersionKey "CompanyName" "TitanRT"
VIAddVersionKey "LegalCopyright" "Supreme Commander 2 Reforged"
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!define APP "Supreme Commander 2 Reforged"
!define KEY "Software\305c1d07-29c7-5ca2-96f8-2b0241c036e4"
!define UNKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\305c1d07-29c7-5ca2-96f8-2b0241c036e4"
!define MUI_ICON "${PAYLOAD}/resources/branding/icon.ico"
!define MUI_UNICON "${PAYLOAD}/resources/branding/icon.ico"
!define MUI_WELCOMEFINISHPAGE_BITMAP "${WELCOME_BITMAP}"
!define MUI_WELCOMEPAGE_TEXT "Setup installs or updates Supreme Commander 2 Reforged. Existing client processes close automatically. Your settings and SupCom 2 game files are kept."
!define MUI_PAGE_CUSTOMFUNCTION_SHOW WelcomeShow
!insertmacro MUI_PAGE_WELCOME
!define MUI_PAGE_CUSTOMFUNCTION_PRE DirectoryPre
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP}.exe"
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
Var ExistingInstall
Var Mutex
Var Staging
Var Script
Var Manifest
Var Powershell

Function WelcomeShow
  ${If} $ExistingInstall == 1
    GetDlgItem $0 $HWNDPARENT 1
    SendMessage $0 ${WM_SETTEXT} 0 "STR:&Update"
  ${EndIf}
FunctionEnd

Function DirectoryPre
  ${If} $ExistingInstall == 1
    Abort
  ${EndIf}
FunctionEnd

!macro UseAllUsers
  UAC::_ 0
  ${If} $0 == 0
    ${If} $1 == 1
      Quit
    ${EndIf}
    ${If} $3 == 0
      Abort
    ${EndIf}
  ${Else}
    MessageBox MB_ICONSTOP "Windows did not permit updating this all-users installation." /SD IDOK
    Abort
  ${EndIf}
  SetShellVarContext all
!macroend

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "This installer requires 64-bit Windows." /SD IDOK
    Abort
  ${EndIf}
  SetRegView 64
  SetShellVarContext current
  StrCpy $ExistingInstall 0
  ReadRegStr $R0 HKCU "${KEY}" "InstallLocation"
  ${If} $R0 == ""
    ReadRegStr $R0 HKLM "${KEY}" "InstallLocation"
    ${If} $R0 != ""
      !insertmacro UseAllUsers
      ReadRegStr $R0 HKLM "${KEY}" "InstallLocation"
    ${EndIf}
  ${EndIf}
  ${If} $R0 != ""
    StrCpy $INSTDIR $R0
    ${If} ${FileExists} "$R0\resources\app.asar"
      ${If} ${FileExists} "$R0\${APP}.exe"
      ${OrIf} ${FileExists} "$R0\SupCom 2 Revival.exe"
        StrCpy $ExistingInstall 1
      ${EndIf}
    ${EndIf}
  ${EndIf}
  System::Call 'kernel32::CreateMutexW(p0, i0, w "305c1d07-29c7-5ca2-96f8-2b0241c036e4") p.r0 ?e'
  StrCpy $Mutex $0
  Pop $0
  ${If} $Mutex == 0
  ${OrIf} $0 == 183
    MessageBox MB_ICONSTOP "Reforged setup is already running." /SD IDOK
    Abort
  ${EndIf}
FunctionEnd

!macro RunUpdate Mode
  nsExec::ExecToLog '"$Powershell" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$Script" -Mode ${Mode} -InstallDirectory "$INSTDIR\." -Manifest "$Manifest" -Payload "$Staging"'
  Pop $0
!macroend

Section "Reforged"
  InitPluginsDir
  StrCpy $Powershell "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  StrCpy $Staging "$PLUGINSDIR\new-app"
  SetOutPath "$Staging"
  ClearErrors
  File /r "${PAYLOAD}/*"
  ${If} ${Errors}
    MessageBox MB_ICONSTOP "Setup could not stage the new application." /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
  StrCpy $Script "$Staging\resources\installer\update-files.ps1"
  StrCpy $Manifest "$Staging\resources\installer\owned-files.json"
  !insertmacro RunUpdate Install
  ${If} $0 != "0"
    MessageBox MB_ICONSTOP "Setup could not update Reforged. See the installation details." /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
  SetOutPath "$INSTDIR"
  ClearErrors
  WriteUninstaller "$INSTDIR\Uninstall ${APP}.exe"
  ${If} ${Errors}
    !insertmacro RunUpdate Rollback
    MessageBox MB_ICONSTOP "Setup could not write the uninstaller and attempted to restore the previous application." /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
  !insertmacro RunUpdate Commit
  ${If} $0 != "0"
    MessageBox MB_ICONSTOP "Setup could not finish the update. See the installation details." /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
  WriteRegStr SHCTX "${KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr SHCTX "${UNKEY}" "DisplayName" "${APP}"
  WriteRegStr SHCTX "${UNKEY}" "Publisher" "TitanRT"
  WriteRegStr SHCTX "${UNKEY}" "DisplayVersion" "0.38.5"
  WriteRegStr SHCTX "${UNKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr SHCTX "${UNKEY}" "UninstallString" '$\"$INSTDIR\Uninstall ${APP}.exe$\"'
  WriteRegStr SHCTX "${UNKEY}" "DisplayIcon" "$INSTDIR\${APP}.exe,0"
  WriteRegDWORD SHCTX "${UNKEY}" "NoModify" 1
  WriteRegDWORD SHCTX "${UNKEY}" "NoRepair" 1
  Delete "$SMPROGRAMS\SupCom 2 Revival.lnk"
  Delete "$DESKTOP\SupCom 2 Revival.lnk"
  CreateShortcut "$SMPROGRAMS\${APP}.lnk" "$INSTDIR\${APP}.exe" "" "$INSTDIR\resources\branding\icon.ico"
  CreateShortcut "$DESKTOP\${APP}.lnk" "$INSTDIR\${APP}.exe" "" "$INSTDIR\resources\branding\icon.ico"
SectionEnd

Function un.onInit
  SetRegView 64
  SetShellVarContext current
  ReadRegStr $R0 HKLM "${KEY}" "InstallLocation"
  ${If} $R0 == $INSTDIR
    !insertmacro UseAllUsers
  ${EndIf}
FunctionEnd

Section "Uninstall"
  InitPluginsDir
  CopyFiles /SILENT "$INSTDIR\resources\installer\update-files.ps1" "$PLUGINSDIR\update-files.ps1"
  CopyFiles /SILENT "$INSTDIR\resources\installer\owned-files.json" "$PLUGINSDIR\owned-files.json"
  StrCpy $Powershell "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  StrCpy $Script "$PLUGINSDIR\update-files.ps1"
  StrCpy $Manifest "$PLUGINSDIR\owned-files.json"
  StrCpy $Staging "$PLUGINSDIR"
  !insertmacro RunUpdate Uninstall
  ${If} $0 != "0"
    MessageBox MB_ICONSTOP "Reforged could not be removed. See the uninstaller details." /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
  DeleteRegKey SHCTX "${UNKEY}"
  DeleteRegKey SHCTX "${KEY}"
  Delete "$SMPROGRAMS\${APP}.lnk"
  Delete "$DESKTOP\${APP}.lnk"
SectionEnd
