// Windows primitives for the runner supervisor. A named job object plays the
// role of the Linux cgroup: every descendant stays inside it, its CPU rate is a
// hard cap that can change while jobs run, and closing the supervisor's handle
// ends the whole tree like systemd's KillMode=control-group.
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;

namespace RunnerFleet
{
    public static class Native
    {
        const int JobObjectExtendedLimitInformation = 9;
        const int JobObjectCpuRateControlInformation = 15;
        const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
        const uint JOB_OBJECT_CPU_RATE_CONTROL_ENABLE = 0x1;
        const uint JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP = 0x4;
        const int ERROR_ALREADY_EXISTS = 183;

        [StructLayout(LayoutKind.Sequential)]
        struct CpuRateControl { public uint ControlFlags; public uint CpuRate; }

        [StructLayout(LayoutKind.Sequential)]
        struct BasicLimit
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct IoCounters
        {
            public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
            public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct ExtendedLimit
        {
            public BasicLimit Basic;
            public IoCounters Io;
            public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref CpuRateControl info, int length);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimit info, int length);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out CpuRateControl info, int length, IntPtr returnLength);
        [DllImport("kernel32.dll")]
        static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool FreeConsole();
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool AttachConsole(uint processId);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint processGroupId);

        // Creates the runner's job, moves the calling process into it, and makes
        // handle closure (supervisor exit or task termination) end every member.
        // The returned handle must stay open for the supervisor's lifetime.
        public static IntPtr CreateSupervisorJob(string name)
        {
            IntPtr job = CreateJobObject(IntPtr.Zero, name);
            if (job == IntPtr.Zero) throw new Win32Exception();
            if (Marshal.GetLastWin32Error() == ERROR_ALREADY_EXISTS)
            {
                CloseHandle(job);
                throw new InvalidOperationException("Another supervisor already owns this runner's job object");
            }
            var limit = new ExtendedLimit();
            limit.Basic.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limit, Marshal.SizeOf(typeof(ExtendedLimit))) ||
                !AssignProcessToJobObject(job, GetCurrentProcess()))
            {
                int error = Marshal.GetLastWin32Error();
                CloseHandle(job);
                throw new Win32Exception(error);
            }
            return job;
        }

        // CPU rates are hundredths of a percent of the whole machine, 1..10000.
        public static uint CpuRateForQuota(int quotaPercent, int cpuCount)
        {
            long rate = (long)Math.Round(quotaPercent * 100.0 / cpuCount);
            return (uint)Math.Max(1, Math.Min(10000, rate));
        }

        public static void SetCpuRate(IntPtr job, uint rate)
        {
            var info = new CpuRateControl
            {
                ControlFlags = JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP,
                CpuRate = rate
            };
            if (!SetInformationJobObject(job, JobObjectCpuRateControlInformation, ref info, Marshal.SizeOf(typeof(CpuRateControl))))
                throw new Win32Exception();
        }

        // Returns the live hard-cap rate, or 0 when uncapped. Job names are
        // per logon session, so other sessions read what the supervisor publishes.
        public static long QueryCpuRate(IntPtr job)
        {
            CpuRateControl info;
            if (!QueryInformationJobObject(job, JobObjectCpuRateControlInformation, out info, Marshal.SizeOf(typeof(CpuRateControl)), IntPtr.Zero))
                throw new Win32Exception();
            return (info.ControlFlags & JOB_OBJECT_CPU_RATE_CONTROL_ENABLE) != 0 ? info.CpuRate : 0;
        }

        // Windows has no SIGINT for another console. Like the runner's own
        // RunnerService.exe, join the listener's console and raise Ctrl+C there.
        // Call this only from a disposable process: it gives up its own console.
        public static bool SendCtrlC(uint processId)
        {
            FreeConsole();
            if (!AttachConsole(processId)) return false;
            SetConsoleCtrlHandler(IntPtr.Zero, true);
            bool sent = GenerateConsoleCtrlEvent(0, 0);
            Thread.Sleep(1000);
            FreeConsole();
            return sent;
        }
    }
}
