; Assisted installers normally skip the directory page for --updated.
; Keep the standard page for manual installs and add an update-only page.
!macro customPageAfterChangeDir
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
