' run-hidden.vbs — launch a node script with NO visible console window.
' Used by the n8n "Execute Command" nodes so the 15-min Lab Agent (and the other
' scheduled agents) run fully in the background instead of popping a terminal.
' Arg 0 = absolute path to the .mjs script. cwd is forced to the repo so the
' agents' relative paths/imports resolve exactly as before.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "C:\Users\gilap\Documents\GitHub\mmmxcix-quant"
' 0 = hidden window, False = fire-and-forget (don't block n8n on the run).
sh.Run """C:\Program Files\nodejs\node.exe"" """ & WScript.Arguments(0) & """", 0, False
