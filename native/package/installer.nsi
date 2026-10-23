; CloseNI's Windows installer: per user, no administrator rights.
;
; Built by native/package/stage.mjs, which stages the app and writes the file
; lists, then runs:
;   makensis /DVERSION=x.y.z /DVERSION4=x.y.z.0 /DOUTFILE=CloseNI-Setup-x.y.z.exe /DICON=closeni.ico
;            /DFILES=install-files.nsh /DUNFILES=uninstall-files.nsh
;            /DSIZE_KB=n installer.nsi
;
; The uninstaller deletes exactly the files the installer put down, never the
; install directory wholesale, and never the user's data (%APPDATA%\CloseNI).
;
; On an upgrade the earlier version's own uninstaller runs first, so files the
; new version no longer ships do not linger.

Unicode true
ManifestDPIAware true
SetCompressor /SOLID lzma
RequestExecutionLevel user

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!include "WinVer.nsh"

!define APP "CloseNI"
!define EXE "CloseNI.exe"
!define UNINSTALLER "uninstall.exe"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\CloseNI"

Name "${APP}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\CloseNI"
InstallDirRegKey HKCU "${UNINSTALL_KEY}" "InstallLocation"
BrandingText "${APP} ${VERSION}"

VIProductVersion "${VERSION4}"
VIAddVersionKey "ProductName" "${APP}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "FileDescription" "${APP} Setup"
VIAddVersionKey "LegalCopyright" "Siddarth S"

!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Start ${APP}"

!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

; Wait until nothing in directory $R9 is running: a running executable cannot
; be opened for writing. Quits if the user gives up.
!macro WAIT_FOR_EXIT UN
Function ${UN}WaitForExit
  ${Do}
    StrCpy $R1 0
    ${If} ${FileExists} "$R9\${EXE}"
      ClearErrors
      FileOpen $R0 "$R9\${EXE}" a
      ${If} ${Errors}
        StrCpy $R1 1
      ${Else}
        FileClose $R0
      ${EndIf}
    ${EndIf}
    ${If} ${FileExists} "$R9\node\node.exe"
      ClearErrors
      FileOpen $R0 "$R9\node\node.exe" a
      ${If} ${Errors}
        StrCpy $R1 1
      ${Else}
        FileClose $R0
      ${EndIf}
    ${EndIf}
    ${If} $R1 == 0
      ${Break}
    ${EndIf}
    ${IfNot} ${Cmd} `MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "${APP} is running. Close it, then choose Retry." /SD IDCANCEL IDRETRY`
      Quit
    ${EndIf}
  ${Loop}
FunctionEnd
!macroend
!insertmacro WAIT_FOR_EXIT ""
!insertmacro WAIT_FOR_EXIT "un."

; Run the uninstaller $R8 that belongs to directory $R9, silently, from a copy:
; run in place (_?=) it cannot delete itself, so the copy is what runs and the
; original is removed with the rest.
Function RunOldUninstaller
  ${If} ${FileExists} "$R9\$R8"
    DetailPrint "Removing the previous version from $R9"
    CopyFiles /SILENT "$R9\$R8" "$PLUGINSDIR\old-uninstaller.exe"
    ExecWait '"$PLUGINSDIR\old-uninstaller.exe" /S _?=$R9'
    Delete "$PLUGINSDIR\old-uninstaller.exe"
    Delete "$R9\$R8"
    RMDir "$R9"
  ${EndIf}
FunctionEnd

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "${APP} needs 64-bit Windows." /SD IDOK
    Quit
  ${EndIf}
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_OK|MB_ICONSTOP "${APP} needs Windows 10 or later." /SD IDOK
    Quit
  ${EndIf}
FunctionEnd

Section "Install"
  InitPluginsDir

  ; An earlier version.
  ReadRegStr $R9 HKCU "${UNINSTALL_KEY}" "InstallLocation"
  ${If} $R9 != ""
    Call WaitForExit
    StrCpy $R8 "${UNINSTALLER}"
    Call RunOldUninstaller
  ${EndIf}

  StrCpy $R9 "$INSTDIR"
  Call WaitForExit

  !include "${FILES}"
  SetOutPath "$INSTDIR"
  WriteUninstaller "$INSTDIR\${UNINSTALLER}"

  CreateShortcut "$SMPROGRAMS\${APP}.lnk" "$INSTDIR\${EXE}"
  CreateShortcut "$DESKTOP\${APP}.lnk" "$INSTDIR\${EXE}"

  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${APP}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "Siddarth S"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\${EXE},0"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\${UNINSTALLER}"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\${UNINSTALLER}" /S'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "EstimatedSize" ${SIZE_KB}
SectionEnd

Function un.onInit
  StrCpy $R9 "$INSTDIR"
  Call un.WaitForExit
FunctionEnd

Section "Uninstall"
  !include "${UNFILES}"
  Delete "$INSTDIR\${UNINSTALLER}"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\${APP}.lnk"
  Delete "$DESKTOP\${APP}.lnk"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
SectionEnd
