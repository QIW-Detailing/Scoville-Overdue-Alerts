Set WshShell = CreateObject("WScript.Shell")
Set FSO = CreateObject("Scripting.FileSystemObject")
AppDir = FSO.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = AppDir
WshShell.Run "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & FSO.BuildPath(AppDir, "launch_helper.ps1") & """", 0, False
