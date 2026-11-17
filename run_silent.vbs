Set WshShell = CreateObject("WScript.Shell")
Set FSO = CreateObject("Scripting.FileSystemObject")
AppDir = FSO.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = AppDir
WshShell.Run "python app.py", 0, False
WScript.Sleep 1500
WshShell.Run "http://127.0.0.1:5055/"
