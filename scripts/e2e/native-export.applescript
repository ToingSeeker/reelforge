on findButton(el, wanted, depth)
  tell application "System Events"
    if depth > 9 then return missing value
    try
      if (role of el as text) is "AXButton" then
        set t to ""
        try
          set t to (value of attribute "AXTitle" of el) as text
        end try
        set d to ""
        try
          set d to description of el as text
        end try
        if t is wanted or d is wanted then return el
      end if
      repeat with c in UI elements of el
        set r to my findButton(c, wanted, depth + 1)
        if r is not missing value then return r
      end repeat
    end try
  end tell
  return missing value
end findButton

on run argv
  set folderPath to item 1 of argv
  set fileName to item 2 of argv
  tell application "System Events"
    tell process "reelforge-desktop"
      set frontmost to true
      set root to UI element 1 of window 1
    end tell
  end tell
  set btn to findButton(root, "Export", 1)
  if btn is missing value then return "FAIL: Export button not found"
  tell application "System Events"
    perform action "AXPress" of btn
    tell process "reelforge-desktop"
      -- the native NSSavePanel appears as a sheet on the window (or as its own window)
      set panel to missing value
      repeat 50 times
        if exists sheet 1 of window 1 then
          set panel to sheet 1 of window 1
          exit repeat
        end if
        delay 0.2
      end repeat
      if panel is missing value then return "FAIL: save panel did not appear; windows=" & (count of windows)
      set form to splitter group 1 of panel
      set suggested to value of text field 1 of form
      set value of text field 1 of form to fileName
      keystroke "g" using {command down, shift down}
      delay 0.8
      keystroke folderPath
      delay 0.4
      key code 36 -- Return: go to folder
      delay 0.8
      if exists button "Save" of form then
        click button "Save" of form
      else
        click button "Save" of panel
      end if
      delay 0.5
      return "OK suggested=" & suggested
    end tell
  end tell
end run
