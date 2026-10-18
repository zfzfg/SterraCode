#define _GNU_SOURCE
#include <sys/prctl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <grp.h>
#include <signal.h>
#include <dirent.h>
#include <errno.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

/* The root monitor is a subreaper. A daemon cannot escape cleanup by double
 * forking, reparenting, setsid(), or changing its process group. It never
 * interprets code, inherits a secret, or accepts a caller-selected UID. */
static volatile sig_atomic_t stopping = 0;
static void stop(int sig) { (void)sig; stopping = 1; }
static long millis(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1000L + t.tv_nsec / 1000000L; }
static void signal_children(pid_t parent, int sig, int depth) {
  if (depth > 256) return;
  DIR *dir = opendir("/proc"); if (!dir) return;
  struct dirent *entry;
  while ((entry = readdir(dir))) {
    char *end; long pid = strtol(entry->d_name, &end, 10);
    if (*end || pid <= 1 || pid == getpid()) continue;
    char name[80], line[512]; snprintf(name, sizeof(name), "/proc/%ld/status", pid);
    FILE *file = fopen(name, "r"); if (!file) continue;
    long ppid = -1;
    while (fgets(line, sizeof(line), file)) if (sscanf(line, "PPid: %ld", &ppid) == 1) break;
    fclose(file);
    if (ppid == parent) { signal_children((pid_t)pid, sig, depth + 1); kill((pid_t)pid, sig); }
  }
  closedir(dir);
}
static int workspace(const char *value) {
  if (!value || value[0] != '/') return -1;
  int fd = open("/", O_DIRECTORY | O_CLOEXEC); if (fd < 0) return -1;
  char *copy = strdup(value), *part, *save = NULL;
  for (part = strtok_r(copy, "/", &save); part; part = strtok_r(NULL, "/", &save)) {
    if (!strcmp(part, ".") || !strcmp(part, "..")) { close(fd); free(copy); errno = EINVAL; return -1; }
    int next = openat(fd, part, O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    close(fd); if (next < 0) { free(copy); return -1; } fd = next;
  }
  free(copy); return fd;
}
int main(int argc, char **argv) {
  if (argc < 3 || geteuid() != 0) { fputs("sterra-launch requires root monitor and cwd/command arguments\n", stderr); return 126; }
  int cwd = workspace(argv[1]); if (cwd < 0) { perror("workspace"); return 126; }
  if (prctl(PR_SET_CHILD_SUBREAPER, 1) < 0) { perror("subreaper"); return 126; }
  struct sigaction action = {0}; action.sa_handler = stop; sigemptyset(&action.sa_mask);
  sigaction(SIGTERM, &action, NULL); sigaction(SIGINT, &action, NULL);
  pid_t child = fork(); if (child < 0) { perror("fork"); return 126; }
  if (!child) {
    signal(SIGTERM, SIG_DFL); signal(SIGINT, SIG_DFL);
    if (setsid() < 0 || fchdir(cwd) < 0 || setgroups(0, NULL) < 0 || setgid(10001) < 0 || setuid(10002) < 0 || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) { perror("unprivileged execution"); _exit(126); }
    close(cwd); umask(0002);
    execvp(argv[2], &argv[2]); perror("exec"); _exit(127);
  }
  close(cwd);
  int main_status = 0, main_done = 0; long deadline = 0;
  for (;;) {
    int status; pid_t reaped;
    while ((reaped = waitpid(-1, &status, WNOHANG)) > 0) if (reaped == child) { main_status = status; main_done = 1; stopping = 1; }
    if (reaped < 0 && errno == ECHILD) break;
    if (stopping) {
      if (!deadline) { deadline = millis() + 1500; signal_children(getpid(), SIGTERM, 0); }
      else if (millis() >= deadline) signal_children(getpid(), SIGKILL, 0);
    }
    struct timespec pause = {0, 20000000}; nanosleep(&pause, NULL);
  }
  if (!main_done) return 143;
  return WIFEXITED(main_status) ? WEXITSTATUS(main_status) : 128 + WTERMSIG(main_status);
}
