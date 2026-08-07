!macro customUnInstall
  ${ifNot} ${isUpdated}
    nsExec::ExecToLog '"$INSTDIR\resources\cli-runtime\cli-uninstaller.exe"'
  ${endIf}
!macroend
