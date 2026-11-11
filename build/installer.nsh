; Assisted installers normally skip the directory page for --updated.
; Keep the standard page for manual installs and add an update-only page.
!ifndef BUILD_UNINSTALLER
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW docNestDirectoryShow

  !macro customInit
    Call docNestDefaultDirectory
  !macroend
!endif

!macro customPageAfterChangeDir
  Function docNestDefaultDirectory
    Push $0
    ${If} ${isUpdated}
      Goto docNestDefaultDone
    ${EndIf}
    ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${If} $0 != ""
      Goto docNestDefaultDone
    ${EndIf}
    ReadRegStr $0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${If} $0 != ""
      Goto docNestDefaultDone
    ${EndIf}
    !insertmacro GetDParameter $0
    ${If} $0 != ""
      Goto docNestDefaultDone
    ${EndIf}
    System::Call 'kernel32::GetDriveTypeW(w "D:\") i.r0'
    ${If} $0 == 3
      StrCpy $INSTDIR "D:\DocNest"
    ${EndIf}
  docNestDefaultDone:
    Pop $0
  FunctionEnd

  Function docNestDirectoryShow
    Push $0
    Call docNestDefaultDirectory
    FindWindow $0 "#32770" "" $HWNDPARENT
    GetDlgItem $0 $0 1019
    SendMessage $0 0x000C 0 "STR:$INSTDIR"
    Pop $0
  FunctionEnd

  Function docNestUpdateDirectoryPre
    ${IfNot} ${isUpdated}
      Abort
    ${EndIf}
  FunctionEnd

  ; Keep the framework hook referenced, but restore the user's exact path
  ; instead of silently appending the new product name to an old install path.
  Function docNestInstFilesPre
    Push $INSTDIR
    Call instFilesPre
    Pop $INSTDIR
  FunctionEnd

  !undef MUI_PAGE_CUSTOMFUNCTION_PRE
  !define MUI_PAGE_CUSTOMFUNCTION_PRE docNestUpdateDirectoryPre
  !insertmacro MUI_PAGE_DIRECTORY
  !define MUI_PAGE_CUSTOMFUNCTION_PRE docNestInstFilesPre
!macroend

!macro customInstall
  !ifdef MENU_FILENAME
    CreateShortCut "$SMPROGRAMS\${MENU_FILENAME}\Uninstall DocNest.lnk" "$INSTDIR\${UNINSTALL_FILENAME}"
  !else
    CreateShortCut "$SMPROGRAMS\Uninstall DocNest.lnk" "$INSTDIR\${UNINSTALL_FILENAME}"
  !endif
!macroend

!macro customUnInstall
  !ifdef MENU_FILENAME
    Delete "$SMPROGRAMS\${MENU_FILENAME}\Uninstall DocNest.lnk"
  !else
    Delete "$SMPROGRAMS\Uninstall DocNest.lnk"
  !endif
!macroend
