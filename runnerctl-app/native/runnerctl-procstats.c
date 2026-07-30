#include <inttypes.h>
#include <libproc.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/resource.h>

int
main(int argc, char *argv[])
{
    for (int index = 1; index < argc; index++) {
        char *end = NULL;
        long parsed_pid = strtol(argv[index], &end, 10);

        if (end == argv[index] || *end != '\0' || parsed_pid <= 0) {
            continue;
        }

        struct rusage_info_v2 usage = {0};
        int pid = (int)parsed_pid;
        int result = proc_pid_rusage(
            pid,
            RUSAGE_INFO_V2,
            (rusage_info_t *)&usage
        );

        if (result != 0) {
            continue;
        }

        printf(
            "%d\t%" PRIu64 "\t%" PRIu64 "\t%" PRIu64 "\t%" PRIu64
            "\t%" PRIu64 "\n",
            pid,
            usage.ri_proc_start_abstime,
            usage.ri_resident_size,
            usage.ri_phys_footprint,
            usage.ri_diskio_bytesread,
            usage.ri_diskio_byteswritten
        );
    }

    return 0;
}
