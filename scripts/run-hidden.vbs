' run-hidden.vbs — launch a node script with NO visible console window.
' Used by the Windows Scheduled Tasks (Lab/Research/Revalidate/Discover) AND by
' lab-agent's internal research spawn, so scheduled agents run fully in the
' background instead of popping a terminal. wscript.exe is itself windowless and
' WScript.Run(..., 0, ...) hides whatever it launches — including cmd — so this is
' reliable where node's own windowsHide flag is not (it's ignored with detached).
'   Arg 0 = absolute path to the .mjs script (required)
'   Arg 1 = log file path (optional) — if given, stdout+stderr are appended there
' cwd is forced to the repo so the agents' relative paths/imports resolve.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "C:\Users\gilap\Documents\GitHub\mmmxcix-quant"
Dim cmd
cmd = """C:\Program Files\nodejs\node.exe"" """ & WScript.Arguments(0) & """"
If WScript.Arguments.Count > 1 Then
  ' Redirect through cmd — still hidden, because wscript launches it with style 0.
  ' cmd /c needs the WHOLE command wrapped in one extra quote pair when it begins
  ' with a quoted path, else it mis-parses the first token.
  cmd = "cmd /c """ & cmd & " >> """ & WScript.Arguments(1) & """ 2>&1"""
End If
' 0 = hidden window, False = fire-and-forget (don't block the caller on the run).
sh.Run cmd, 0, False
