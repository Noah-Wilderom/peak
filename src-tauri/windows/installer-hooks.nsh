; Puts the install directory on this user's PATH, so `peak-cli` works in a new terminal.
!macro NSIS_HOOK_POSTINSTALL
  nsExec::Exec `powershell -NoProfile -ExecutionPolicy Bypass -Command "$d = '$INSTDIR'; $p = [Environment]::GetEnvironmentVariable('Path', 'User'); if (-not (($p -split ';') -contains $d)) { [Environment]::SetEnvironmentVariable('Path', ($p.TrimEnd(';') + ';' + $d), 'User') }"`
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec `powershell -NoProfile -ExecutionPolicy Bypass -Command "$d = '$INSTDIR'; $p = [Environment]::GetEnvironmentVariable('Path', 'User'); [Environment]::SetEnvironmentVariable('Path', (($p -split ';' | Where-Object { $_ -ne $d }) -join ';'), 'User')"`
!macroend
