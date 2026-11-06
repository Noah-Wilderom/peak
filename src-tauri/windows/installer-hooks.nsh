; A running program can't be overwritten on Windows, but it can be renamed. `peak-cli` is often
; running a user's command during an update, and must carry on, so it's moved aside first.
; Copies left by earlier updates go once nothing is running from them.
!macro NSIS_HOOK_PREINSTALL
  Delete "$INSTDIR\peak-cli.old.*"
  System::Call 'kernel32::GetTickCount()i.r0'
  Rename "$INSTDIR\peak-cli.exe" "$INSTDIR\peak-cli.old.$0"
!macroend

; Puts the install directory on this user's PATH, so `peak-cli` works in a new terminal.
!macro NSIS_HOOK_POSTINSTALL
  nsExec::Exec `powershell -NoProfile -ExecutionPolicy Bypass -Command "$d = '$INSTDIR'; $p = [Environment]::GetEnvironmentVariable('Path', 'User'); if (-not (($p -split ';') -contains $d)) { [Environment]::SetEnvironmentVariable('Path', ($p.TrimEnd(';') + ';' + $d), 'User') }"`
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Delete "$INSTDIR\peak-cli.old.*"
  nsExec::Exec `powershell -NoProfile -ExecutionPolicy Bypass -Command "$d = '$INSTDIR'; $p = [Environment]::GetEnvironmentVariable('Path', 'User'); [Environment]::SetEnvironmentVariable('Path', (($p -split ';' | Where-Object { $_ -ne $d }) -join ';'), 'User')"`
!macroend
