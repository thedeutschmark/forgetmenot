// Windows job object support — ensures the runtime child process is killed
// when the tray dies, even on force-kill (taskkill /F, log off, crash).
//
// Without this, force-killing the tray orphans the runtime indefinitely.
package main

import (
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

var jobHandle windows.Handle

// initJobObject creates a job object configured with KILL_ON_JOB_CLOSE.
// Any process assigned to this job is killed when the job handle closes
// (which happens automatically when this process exits, for any reason).
func initJobObject() error {
	h, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return err
	}

	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{
		BasicLimitInformation: windows.JOBOBJECT_BASIC_LIMIT_INFORMATION{
			LimitFlags: windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
		},
	}

	_, err = windows.SetInformationJobObject(
		h,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info)),
	)
	if err != nil {
		windows.CloseHandle(h)
		return err
	}

	jobHandle = h
	return nil
}

// assignToJob adds the given process to the job object so it gets killed
// when the tray dies.
func assignToJob(p *os.Process) error {
	if jobHandle == 0 {
		return nil // job not initialized — no-op rather than fail
	}
	pHandle, err := windows.OpenProcess(
		windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE,
		false,
		uint32(p.Pid),
	)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(pHandle)
	return windows.AssignProcessToJobObject(jobHandle, pHandle)
}
