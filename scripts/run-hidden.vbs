' run-hidden.vbs — launch a node script with NO visible console window.
'
' Used by the Windows Scheduled Tasks (Lab/Research/Revalidate/Discover) AND by
' lab-agent's internal research spawn. wscript.exe is itself windowless and
' WScript.Shell.Run(cmd, 0, False) starts the child hidden.
'
' IMPORTANT (Windows 11): this only stays hidden when the default terminal is the
' classic Console Host. If the default terminal is "Windows Terminal", WT hijacks
' every newly created console and shows it in its own window, ignoring the hide
' flag — that is a Windows-level behaviour no launcher can override. Set
'   Settings → System → For developers → Terminal → Windows Console Host
' (or HKCU\Console\%%Startup DelegationConsole/DelegationTerminal =
' {00000000-0000-0000-0000-000000000000}) to keep background agents invisible.
'
'   Arg 0 = absolute path to the .mjs script (required)
'   Arg 1 = log file path (optional) — stdout+stderr appended there
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "C:\Users\gilap\Documents\GitHub\mmmxcix-quant"
Dim cmd
cmd = """C:\Program Files\nodejs\node.exe"" """ & WScript.Arguments(0) & """"
If WScript.Arguments.Count > 1 Then
  ' cmd /c needs the WHOLE command in one extra quote pair when it starts with a
  ' quoted path, else it mis-parses the first token.
  cmd = "cmd /c """ & cmd & " >> """ & WScript.Arguments(1) & """ 2>&1"""
End If
sh.Run cmd, 0, False
