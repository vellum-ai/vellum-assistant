/**
 * Default command registry for the bash risk classifier.
 *
 * Registry is split by top-level command to keep per-command risk rules small
 * and maintainable.
 */

import type { CommandRiskSpec } from "../risk-types.js";
import cmd__7z from "./commands/7z.js";
import cmd__7za from "./commands/7za.js";
import cmd_ack from "./commands/ack.js";
import cmd_adduser from "./commands/adduser.js";
import cmd_ag from "./commands/ag.js";
import cmd_alias from "./commands/alias.js";
import cmd_ant from "./commands/ant.js";
import cmd_apk from "./commands/apk.js";
import cmd_apt from "./commands/apt.js";
import cmd_apt_get from "./commands/apt-get.js";
import cmd_assistant from "./commands/assistant.js";
import cmd_at from "./commands/at.js";
import cmd_awk from "./commands/awk.js";
import cmd_aws from "./commands/aws.js";
import cmd_az from "./commands/az.js";
import cmd_b2sum from "./commands/b2sum.js";
import cmd_base64 from "./commands/base64.js";
import cmd_basename from "./commands/basename.js";
import cmd_bash from "./commands/bash.js";
import cmd_bazel from "./commands/bazel.js";
import cmd_brew from "./commands/brew.js";
import cmd_bun from "./commands/bun.js";
import cmd_bunx from "./commands/bunx.js";
import cmd_bunzip2 from "./commands/bunzip2.js";
import cmd_bzip2 from "./commands/bzip2.js";
import cmd_cal from "./commands/cal.js";
import cmd_cargo from "./commands/cargo.js";
import cmd_cat from "./commands/cat.js";
import cmd_cd from "./commands/cd.js";
import cmd_chgrp from "./commands/chgrp.js";
import cmd_chmod from "./commands/chmod.js";
import cmd_chown from "./commands/chown.js";
import cmd_chroot from "./commands/chroot.js";
import cmd_cksum from "./commands/cksum.js";
import cmd_cmake from "./commands/cmake.js";
import cmd_cmp from "./commands/cmp.js";
import cmd_column from "./commands/column.js";
import cmd_comm from "./commands/comm.js";
import cmd_command from "./commands/command.js";
import cmd_composer from "./commands/composer.js";
import cmd_cp from "./commands/cp.js";
import cmd_crontab from "./commands/crontab.js";
import cmd_csplit from "./commands/csplit.js";
import cmd_curl from "./commands/curl.js";
import cmd_cut from "./commands/cut.js";
import cmd_dash from "./commands/dash.js";
import cmd_date from "./commands/date.js";
import cmd_dd from "./commands/dd.js";
import cmd_declare from "./commands/declare.js";
import cmd_defaults from "./commands/defaults.js";
import cmd_deluser from "./commands/deluser.js";
import cmd_deno from "./commands/deno.js";
import cmd_df from "./commands/df.js";
import cmd_diff from "./commands/diff.js";
import cmd_dig from "./commands/dig.js";
import cmd_dir from "./commands/dir.js";
import cmd_dirname from "./commands/dirname.js";
import cmd_dmesg from "./commands/dmesg.js";
import cmd_dnf from "./commands/dnf.js";
import cmd_doas from "./commands/doas.js";
import cmd_docker from "./commands/docker.js";
import cmd_dos2unix from "./commands/dos2unix.js";
import cmd_du from "./commands/du.js";
import cmd_echo from "./commands/echo.js";
import cmd_egrep from "./commands/egrep.js";
import cmd_env from "./commands/env.js";
import cmd_eval from "./commands/eval.js";
import cmd_exec from "./commands/exec.js";
import cmd_expand from "./commands/expand.js";
import cmd_export from "./commands/export.js";
import cmd_fd from "./commands/fd.js";
import cmd_fdisk from "./commands/fdisk.js";
import cmd_fgrep from "./commands/fgrep.js";
import cmd_file from "./commands/file.js";
import cmd_find from "./commands/find.js";
import cmd_firewall_cmd from "./commands/firewall-cmd.js";
import cmd_fish from "./commands/fish.js";
import cmd_fmt from "./commands/fmt.js";
import cmd_fold from "./commands/fold.js";
import cmd_free from "./commands/free.js";
import cmd_ftp from "./commands/ftp.js";
import cmd_gcloud from "./commands/gcloud.js";
import cmd_gem from "./commands/gem.js";
import cmd_gh from "./commands/gh.js";
import cmd_git from "./commands/git.js";
import cmd_go from "./commands/go.js";
import cmd_gradle from "./commands/gradle.js";
import cmd_grep from "./commands/grep.js";
import cmd_groupadd from "./commands/groupadd.js";
import cmd_groupdel from "./commands/groupdel.js";
import cmd_groupmod from "./commands/groupmod.js";
import cmd_groups from "./commands/groups.js";
import cmd_gunzip from "./commands/gunzip.js";
import cmd_gzip from "./commands/gzip.js";
import cmd_halt from "./commands/halt.js";
import cmd_head from "./commands/head.js";
import cmd_helm from "./commands/helm.js";
import cmd_help from "./commands/help.js";
import cmd_hexdump from "./commands/hexdump.js";
import cmd_hg from "./commands/hg.js";
import cmd_history from "./commands/history.js";
import cmd_host from "./commands/host.js";
import cmd_hostname from "./commands/hostname.js";
import cmd_htop from "./commands/htop.js";
import cmd_http from "./commands/http.js";
import cmd_iconv from "./commands/iconv.js";
import cmd_id from "./commands/id.js";
import cmd_ifconfig from "./commands/ifconfig.js";
import cmd_info from "./commands/info.js";
import cmd_install from "./commands/install.js";
import cmd_ionice from "./commands/ionice.js";
import cmd_iostat from "./commands/iostat.js";
import cmd_ip from "./commands/ip.js";
import cmd_ip6tables from "./commands/ip6tables.js";
import cmd_iptables from "./commands/iptables.js";
import cmd_java from "./commands/java.js";
import cmd_javac from "./commands/javac.js";
import cmd_join from "./commands/join.js";
import cmd_jq from "./commands/jq.js";
import cmd_kill from "./commands/kill.js";
import cmd_killall from "./commands/killall.js";
import cmd_ksh from "./commands/ksh.js";
import cmd_kubectl from "./commands/kubectl.js";
import cmd_last from "./commands/last.js";
import cmd_launchctl from "./commands/launchctl.js";
import cmd_less from "./commands/less.js";
import cmd_ln from "./commands/ln.js";
import cmd_locate from "./commands/locate.js";
import cmd_loginctl from "./commands/loginctl.js";
import cmd_ls from "./commands/ls.js";
import cmd_lsof from "./commands/lsof.js";
import cmd_ltrace from "./commands/ltrace.js";
import cmd_lua from "./commands/lua.js";
import cmd_make from "./commands/make.js";
import cmd_man from "./commands/man.js";
import cmd_md5 from "./commands/md5.js";
import cmd_md5sum from "./commands/md5sum.js";
import cmd_meson from "./commands/meson.js";
import cmd_mkdir from "./commands/mkdir.js";
import cmd_mkfs from "./commands/mkfs.js";
import cmd_mktemp from "./commands/mktemp.js";
import cmd_more from "./commands/more.js";
import cmd_mount from "./commands/mount.js";
import cmd_mtr from "./commands/mtr.js";
import cmd_mv from "./commands/mv.js";
import cmd_mvn from "./commands/mvn.js";
import cmd_nc from "./commands/nc.js";
import cmd_netcat from "./commands/netcat.js";
import cmd_netstat from "./commands/netstat.js";
import cmd_networksetup from "./commands/networksetup.js";
import cmd_nft from "./commands/nft.js";
import cmd_nice from "./commands/nice.js";
import cmd_ninja from "./commands/ninja.js";
import cmd_nl from "./commands/nl.js";
import cmd_nmap from "./commands/nmap.js";
import cmd_nmcli from "./commands/nmcli.js";
import cmd_node from "./commands/node.js";
import cmd_nohup from "./commands/nohup.js";
import cmd_npm from "./commands/npm.js";
import cmd_npx from "./commands/npx.js";
import cmd_nslookup from "./commands/nslookup.js";
import cmd_od from "./commands/od.js";
import cmd_openssl from "./commands/openssl.js";
import cmd_pacman from "./commands/pacman.js";
import cmd_parted from "./commands/parted.js";
import cmd_passwd from "./commands/passwd.js";
import cmd_paste from "./commands/paste.js";
import cmd_perl from "./commands/perl.js";
import cmd_pgrep from "./commands/pgrep.js";
import cmd_php from "./commands/php.js";
import cmd_ping from "./commands/ping.js";
import cmd_pip from "./commands/pip.js";
import cmd_pip3 from "./commands/pip3.js";
import cmd_pipx from "./commands/pipx.js";
import cmd_pkill from "./commands/pkill.js";
import cmd_plocate from "./commands/plocate.js";
import cmd_pnpm from "./commands/pnpm.js";
import cmd_pnpx from "./commands/pnpx.js";
import cmd_poetry from "./commands/poetry.js";
import cmd_popd from "./commands/popd.js";
import cmd_port from "./commands/port.js";
import cmd_poweroff from "./commands/poweroff.js";
import cmd_powershell from "./commands/powershell.js";
import cmd_pr from "./commands/pr.js";
import cmd_printenv from "./commands/printenv.js";
import cmd_printf from "./commands/printf.js";
import cmd_ps from "./commands/ps.js";
import cmd_pstree from "./commands/pstree.js";
import cmd_pushd from "./commands/pushd.js";
import cmd_pwd from "./commands/pwd.js";
import cmd_pwsh from "./commands/pwsh.js";
import cmd_python from "./commands/python.js";
import cmd_python3 from "./commands/python3.js";
import cmd_R from "./commands/R.js";
import cmd_readlink from "./commands/readlink.js";
import cmd_readonly from "./commands/readonly.js";
import cmd_realpath from "./commands/realpath.js";
import cmd_reboot from "./commands/reboot.js";
import cmd_renice from "./commands/renice.js";
import cmd_rev from "./commands/rev.js";
import cmd_rg from "./commands/rg.js";
import cmd_rm from "./commands/rm.js";
import cmd_rmdir from "./commands/rmdir.js";
import cmd_route from "./commands/route.js";
import cmd_Rscript from "./commands/Rscript.js";
import cmd_rsync from "./commands/rsync.js";
import cmd_ruby from "./commands/ruby.js";
import cmd_scp from "./commands/scp.js";
import cmd_screen from "./commands/screen.js";
import cmd_sed from "./commands/sed.js";
import cmd_seq from "./commands/seq.js";
import cmd_service from "./commands/service.js";
import cmd_set from "./commands/set.js";
import cmd_sftp from "./commands/sftp.js";
import cmd_sh from "./commands/sh.js";
import cmd_sha1sum from "./commands/sha1sum.js";
import cmd_sha256sum from "./commands/sha256sum.js";
import cmd_sha512sum from "./commands/sha512sum.js";
import cmd_shred from "./commands/shred.js";
import cmd_shuf from "./commands/shuf.js";
import cmd_shutdown from "./commands/shutdown.js";
import cmd_sleep from "./commands/sleep.js";
import cmd_sort from "./commands/sort.js";
import cmd_source from "./commands/source.js";
import cmd_split from "./commands/split.js";
import cmd_ss from "./commands/ss.js";
import cmd_ssh from "./commands/ssh.js";
import cmd_ssh_add from "./commands/ssh-add.js";
import cmd_ssh_copy_id from "./commands/ssh-copy-id.js";
import cmd_ssh_keygen from "./commands/ssh-keygen.js";
import cmd_stat from "./commands/stat.js";
import cmd_strace from "./commands/strace.js";
import cmd_strings from "./commands/strings.js";
import cmd_su from "./commands/su.js";
import cmd_sudo from "./commands/sudo.js";
import cmd_svn from "./commands/svn.js";
import cmd_sw_vers from "./commands/sw_vers.js";
import cmd_swift from "./commands/swift.js";
import cmd_sysctl from "./commands/sysctl.js";
import cmd_systemctl from "./commands/systemctl.js";
import cmd_tail from "./commands/tail.js";
import cmd_tar from "./commands/tar.js";
import cmd_taskset from "./commands/taskset.js";
import cmd_tcsh from "./commands/tcsh.js";
import cmd_tee from "./commands/tee.js";
import cmd_telnet from "./commands/telnet.js";
import cmd_terraform from "./commands/terraform.js";
import cmd_time from "./commands/time.js";
import cmd_timeout from "./commands/timeout.js";
import cmd_tmux from "./commands/tmux.js";
import cmd_top from "./commands/top.js";
import cmd_touch from "./commands/touch.js";
import cmd_tr from "./commands/tr.js";
import cmd_tracepath from "./commands/tracepath.js";
import cmd_traceroute from "./commands/traceroute.js";
import cmd_tree from "./commands/tree.js";
import cmd_truncate from "./commands/truncate.js";
import cmd_ts_node from "./commands/ts-node.js";
import cmd_tsx from "./commands/tsx.js";
import cmd_type from "./commands/type.js";
import cmd_typeset from "./commands/typeset.js";
import cmd_ufw from "./commands/ufw.js";
import cmd_umask from "./commands/umask.js";
import cmd_umount from "./commands/umount.js";
import cmd_uname from "./commands/uname.js";
import cmd_unexpand from "./commands/unexpand.js";
import cmd_uniq from "./commands/uniq.js";
import cmd_unix2dos from "./commands/unix2dos.js";
import cmd_unlink from "./commands/unlink.js";
import cmd_unset from "./commands/unset.js";
import cmd_unxz from "./commands/unxz.js";
import cmd_unzip from "./commands/unzip.js";
import cmd_unzstd from "./commands/unzstd.js";
import cmd_uptime from "./commands/uptime.js";
import cmd_useradd from "./commands/useradd.js";
import cmd_userdel from "./commands/userdel.js";
import cmd_usermod from "./commands/usermod.js";
import cmd_users from "./commands/users.js";
import cmd_uv from "./commands/uv.js";
import cmd_vdir from "./commands/vdir.js";
import cmd_visudo from "./commands/visudo.js";
import cmd_vmstat from "./commands/vmstat.js";
import cmd_w from "./commands/w.js";
import cmd_watch from "./commands/watch.js";
import cmd_wc from "./commands/wc.js";
import cmd_wget from "./commands/wget.js";
import cmd_where from "./commands/where.js";
import cmd_whereis from "./commands/whereis.js";
import cmd_which from "./commands/which.js";
import cmd_who from "./commands/who.js";
import cmd_whoami from "./commands/whoami.js";
import cmd_wipefs from "./commands/wipefs.js";
import cmd_xargs from "./commands/xargs.js";
import cmd_xxd from "./commands/xxd.js";
import cmd_xz from "./commands/xz.js";
import cmd_yarn from "./commands/yarn.js";
import cmd_yes from "./commands/yes.js";
import cmd_yq from "./commands/yq.js";
import cmd_yum from "./commands/yum.js";
import cmd_zip from "./commands/zip.js";
import cmd_zsh from "./commands/zsh.js";
import cmd_zstd from "./commands/zstd.js";
import cmd_zypper from "./commands/zypper.js";

export const DEFAULT_COMMAND_REGISTRY = {
  "7z": cmd__7z,
  "7za": cmd__7za,
  ack: cmd_ack,
  adduser: cmd_adduser,
  ag: cmd_ag,
  alias: cmd_alias,
  ant: cmd_ant,
  apk: cmd_apk,
  apt: cmd_apt,
  "apt-get": cmd_apt_get,
  assistant: cmd_assistant,
  at: cmd_at,
  awk: cmd_awk,
  aws: cmd_aws,
  az: cmd_az,
  b2sum: cmd_b2sum,
  base64: cmd_base64,
  basename: cmd_basename,
  bash: cmd_bash,
  bazel: cmd_bazel,
  brew: cmd_brew,
  bun: cmd_bun,
  bunx: cmd_bunx,
  bunzip2: cmd_bunzip2,
  bzip2: cmd_bzip2,
  cal: cmd_cal,
  cargo: cmd_cargo,
  cat: cmd_cat,
  cd: cmd_cd,
  chgrp: cmd_chgrp,
  chmod: cmd_chmod,
  chown: cmd_chown,
  chroot: cmd_chroot,
  cksum: cmd_cksum,
  cmake: cmd_cmake,
  cmp: cmd_cmp,
  column: cmd_column,
  comm: cmd_comm,
  command: cmd_command,
  composer: cmd_composer,
  cp: cmd_cp,
  crontab: cmd_crontab,
  csplit: cmd_csplit,
  curl: cmd_curl,
  cut: cmd_cut,
  dash: cmd_dash,
  date: cmd_date,
  dd: cmd_dd,
  declare: cmd_declare,
  defaults: cmd_defaults,
  deluser: cmd_deluser,
  deno: cmd_deno,
  df: cmd_df,
  diff: cmd_diff,
  dig: cmd_dig,
  dir: cmd_dir,
  dirname: cmd_dirname,
  dmesg: cmd_dmesg,
  dnf: cmd_dnf,
  doas: cmd_doas,
  docker: cmd_docker,
  dos2unix: cmd_dos2unix,
  du: cmd_du,
  echo: cmd_echo,
  egrep: cmd_egrep,
  env: cmd_env,
  eval: cmd_eval,
  exec: cmd_exec,
  expand: cmd_expand,
  export: cmd_export,
  fd: cmd_fd,
  fdisk: cmd_fdisk,
  fgrep: cmd_fgrep,
  file: cmd_file,
  find: cmd_find,
  "firewall-cmd": cmd_firewall_cmd,
  fish: cmd_fish,
  fmt: cmd_fmt,
  fold: cmd_fold,
  free: cmd_free,
  ftp: cmd_ftp,
  gcloud: cmd_gcloud,
  gem: cmd_gem,
  gh: cmd_gh,
  git: cmd_git,
  go: cmd_go,
  gradle: cmd_gradle,
  grep: cmd_grep,
  groupadd: cmd_groupadd,
  groupdel: cmd_groupdel,
  groupmod: cmd_groupmod,
  groups: cmd_groups,
  gunzip: cmd_gunzip,
  gzip: cmd_gzip,
  halt: cmd_halt,
  head: cmd_head,
  helm: cmd_helm,
  help: cmd_help,
  hexdump: cmd_hexdump,
  hg: cmd_hg,
  history: cmd_history,
  host: cmd_host,
  hostname: cmd_hostname,
  htop: cmd_htop,
  http: cmd_http,
  iconv: cmd_iconv,
  id: cmd_id,
  ifconfig: cmd_ifconfig,
  info: cmd_info,
  install: cmd_install,
  ionice: cmd_ionice,
  iostat: cmd_iostat,
  ip: cmd_ip,
  ip6tables: cmd_ip6tables,
  iptables: cmd_iptables,
  java: cmd_java,
  javac: cmd_javac,
  join: cmd_join,
  jq: cmd_jq,
  kill: cmd_kill,
  killall: cmd_killall,
  ksh: cmd_ksh,
  kubectl: cmd_kubectl,
  last: cmd_last,
  launchctl: cmd_launchctl,
  less: cmd_less,
  ln: cmd_ln,
  locate: cmd_locate,
  loginctl: cmd_loginctl,
  ls: cmd_ls,
  lsof: cmd_lsof,
  ltrace: cmd_ltrace,
  lua: cmd_lua,
  make: cmd_make,
  man: cmd_man,
  md5: cmd_md5,
  md5sum: cmd_md5sum,
  meson: cmd_meson,
  mkdir: cmd_mkdir,
  mkfs: cmd_mkfs,
  mktemp: cmd_mktemp,
  more: cmd_more,
  mount: cmd_mount,
  mtr: cmd_mtr,
  mv: cmd_mv,
  mvn: cmd_mvn,
  nc: cmd_nc,
  netcat: cmd_netcat,
  netstat: cmd_netstat,
  networksetup: cmd_networksetup,
  nft: cmd_nft,
  nice: cmd_nice,
  ninja: cmd_ninja,
  nl: cmd_nl,
  nmap: cmd_nmap,
  nmcli: cmd_nmcli,
  node: cmd_node,
  nohup: cmd_nohup,
  npm: cmd_npm,
  npx: cmd_npx,
  nslookup: cmd_nslookup,
  od: cmd_od,
  openssl: cmd_openssl,
  pacman: cmd_pacman,
  parted: cmd_parted,
  passwd: cmd_passwd,
  paste: cmd_paste,
  perl: cmd_perl,
  pgrep: cmd_pgrep,
  php: cmd_php,
  ping: cmd_ping,
  pip: cmd_pip,
  pip3: cmd_pip3,
  pipx: cmd_pipx,
  pkill: cmd_pkill,
  plocate: cmd_plocate,
  pnpm: cmd_pnpm,
  pnpx: cmd_pnpx,
  poetry: cmd_poetry,
  popd: cmd_popd,
  port: cmd_port,
  poweroff: cmd_poweroff,
  powershell: cmd_powershell,
  pr: cmd_pr,
  printenv: cmd_printenv,
  printf: cmd_printf,
  ps: cmd_ps,
  pstree: cmd_pstree,
  pushd: cmd_pushd,
  pwd: cmd_pwd,
  pwsh: cmd_pwsh,
  python: cmd_python,
  python3: cmd_python3,
  R: cmd_R,
  readlink: cmd_readlink,
  readonly: cmd_readonly,
  realpath: cmd_realpath,
  reboot: cmd_reboot,
  renice: cmd_renice,
  rev: cmd_rev,
  rg: cmd_rg,
  rm: cmd_rm,
  rmdir: cmd_rmdir,
  route: cmd_route,
  Rscript: cmd_Rscript,
  rsync: cmd_rsync,
  ruby: cmd_ruby,
  scp: cmd_scp,
  screen: cmd_screen,
  sed: cmd_sed,
  seq: cmd_seq,
  service: cmd_service,
  set: cmd_set,
  sftp: cmd_sftp,
  sh: cmd_sh,
  sha1sum: cmd_sha1sum,
  sha256sum: cmd_sha256sum,
  sha512sum: cmd_sha512sum,
  shred: cmd_shred,
  shuf: cmd_shuf,
  shutdown: cmd_shutdown,
  sleep: cmd_sleep,
  sort: cmd_sort,
  source: cmd_source,
  split: cmd_split,
  ss: cmd_ss,
  ssh: cmd_ssh,
  "ssh-add": cmd_ssh_add,
  "ssh-copy-id": cmd_ssh_copy_id,
  "ssh-keygen": cmd_ssh_keygen,
  stat: cmd_stat,
  strace: cmd_strace,
  strings: cmd_strings,
  su: cmd_su,
  sudo: cmd_sudo,
  svn: cmd_svn,
  sw_vers: cmd_sw_vers,
  swift: cmd_swift,
  sysctl: cmd_sysctl,
  systemctl: cmd_systemctl,
  tail: cmd_tail,
  tar: cmd_tar,
  taskset: cmd_taskset,
  tcsh: cmd_tcsh,
  tee: cmd_tee,
  telnet: cmd_telnet,
  terraform: cmd_terraform,
  time: cmd_time,
  timeout: cmd_timeout,
  tmux: cmd_tmux,
  top: cmd_top,
  touch: cmd_touch,
  tr: cmd_tr,
  tracepath: cmd_tracepath,
  traceroute: cmd_traceroute,
  tree: cmd_tree,
  truncate: cmd_truncate,
  "ts-node": cmd_ts_node,
  tsx: cmd_tsx,
  type: cmd_type,
  typeset: cmd_typeset,
  ufw: cmd_ufw,
  umask: cmd_umask,
  umount: cmd_umount,
  uname: cmd_uname,
  unexpand: cmd_unexpand,
  uniq: cmd_uniq,
  unix2dos: cmd_unix2dos,
  unlink: cmd_unlink,
  unset: cmd_unset,
  unxz: cmd_unxz,
  unzip: cmd_unzip,
  unzstd: cmd_unzstd,
  uptime: cmd_uptime,
  useradd: cmd_useradd,
  userdel: cmd_userdel,
  usermod: cmd_usermod,
  users: cmd_users,
  uv: cmd_uv,
  vdir: cmd_vdir,
  visudo: cmd_visudo,
  vmstat: cmd_vmstat,
  w: cmd_w,
  watch: cmd_watch,
  wc: cmd_wc,
  wget: cmd_wget,
  where: cmd_where,
  whereis: cmd_whereis,
  which: cmd_which,
  who: cmd_who,
  whoami: cmd_whoami,
  wipefs: cmd_wipefs,
  xargs: cmd_xargs,
  xxd: cmd_xxd,
  xz: cmd_xz,
  yarn: cmd_yarn,
  yes: cmd_yes,
  yq: cmd_yq,
  yum: cmd_yum,
  zip: cmd_zip,
  zsh: cmd_zsh,
  zstd: cmd_zstd,
  zypper: cmd_zypper,
} satisfies Record<string, CommandRiskSpec>;
