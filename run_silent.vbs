Option Explicit

Dim WshShell, FSO, AppDir, DataDir, SavedPyFile, PyExe, LogFile, NoBrowser, i
Set WshShell = CreateObject("WScript.Shell")
Set FSO = CreateObject("Scripting.FileSystemObject")

AppDir = FSO.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = AppDir

NoBrowser = False
For i = 0 To WScript.Arguments.Count - 1
    If LCase(WScript.Arguments(i)) = "--no-browser" Then
        NoBrowser = True
    End If
Next

Function IsServerUp()
    On Error Resume Next
    Dim http
    Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
    http.setTimeouts 1000, 1000, 1000, 1000
    http.Open "GET", "http://127.0.0.1:5055/api/ping", False
    http.Send
    If Err.Number = 0 And http.Status = 200 Then
        IsServerUp = True
    Else
        IsServerUp = False
    End If
    On Error GoTo 0
End Function

DataDir = FSO.BuildPath(AppDir, "data")
If Not FSO.FolderExists(DataDir) Then
    On Error Resume Next
    FSO.CreateFolder DataDir
    On Error GoTo 0
End If

SavedPyFile = FSO.BuildPath(DataDir, "python_exe.txt")
PyExe = ""
If FSO.FileExists(SavedPyFile) Then
    Dim ts
    Set ts = FSO.OpenTextFile(SavedPyFile, 1)
    If Not ts.AtEndOfStream Then
        PyExe = Trim(Replace(Replace(ts.ReadAll(), vbCr, ""), vbLf, ""))
    End If
    ts.Close
    If Not FSO.FileExists(PyExe) Then
        PyExe = ""
    End If
End If

If PyExe = "" Then
    PyExe = "python"
End If

If Not IsServerUp() Then
    LogFile = FSO.BuildPath(DataDir, "server.log")
    Dim Cmd
    Cmd = "cmd.exe /c """"" & PyExe & """ """ & FSO.BuildPath(AppDir, "app.py") & """ > """ & LogFile & """ 2>&1"""
    WshShell.Run Cmd, 0, False

    Dim tries
    For tries = 1 To 20
        WScript.Sleep 500
        If IsServerUp() Then Exit For
    Next
End If

If Not NoBrowser Then
    WshShell.Run "http://127.0.0.1:5055/"
End If
