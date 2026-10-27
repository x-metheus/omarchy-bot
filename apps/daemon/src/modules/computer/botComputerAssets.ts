import {
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createReadStream } from "node:fs";
import path from "node:path";

export interface PinnedAsset {
  name: string;
  url: string;
  sha256: string;
}

/**
 * Chrome for Testing is Chromium-compatible, published at an immutable
 * versioned URL, and is the same browser build on every host. It is compiled
 * against glibc, so it is always launched through the bundled loader below.
 */
export const BROWSER_ASSET: PinnedAsset = Object.freeze({
  name: "chrome-for-testing-linux64",
  url: "https://storage.googleapis.com/chrome-for-testing-public/156.0.8078.47/linux64/chrome-linux64.zip",
  sha256: "e6c94490f0b6b337225aeb2d2a5034858516b7017356980ba94f5176d8774a50",
});


/**
 * The browser's non-libc library closure, taken from pinned Ubuntu 24.04
 * packages. Ubuntu 24.04 ships every package as zstd, and Bun reads zstd and
 * tar natively, so extraction needs no host `dpkg`, `ar`, `zstd`, or `xz`.
 *
 * The closure includes the loader itself, so the bundled browser runs
 * unchanged on glibc and musl hosts: the shim always starts the bundled
 * `ld-linux-x86-64.so.2`, which never consults the host's dynamic loader.
 */
export const BROWSER_LIBRARY_ASSETS: readonly PinnedAsset[] = Object.freeze([
  { name: "libapparmor1", url: "https://archive.ubuntu.com/ubuntu/pool/main/a/apparmor/libapparmor1_4.0.1really4.0.1-0ubuntu0.24.04.9_amd64.deb", sha256: "75b570d7517e24c3693c4503b4691ac1fd82934d93faa91460309f22104c5617" },
  { name: "libasound2t64", url: "https://archive.ubuntu.com/ubuntu/pool/main/a/alsa-lib/libasound2t64_1.2.11-1ubuntu0.3_amd64.deb", sha256: "5d17bfb5683eb99f1be951fe48e1be5bf3c52391913b6b74a8aecf9b4f5e779f" },
  { name: "libasyncns0", url: "https://archive.ubuntu.com/ubuntu/pool/main/liba/libasyncns/libasyncns0_0.8-6build4_amd64.deb", sha256: "f8483917fd216e248143eba1c80dfc9384b94fb4dac402194a98c11505674269" },
  { name: "libatk-bridge2.0-0t64", url: "https://archive.ubuntu.com/ubuntu/pool/main/a/at-spi2-core/libatk-bridge2.0-0t64_2.52.0-1build1_amd64.deb", sha256: "22b7d47e3c0f7953a78d3cfd309d1b20771085de9220fbe610c0989b9e808c9b" },
  { name: "libatk1.0-0t64", url: "https://archive.ubuntu.com/ubuntu/pool/main/a/at-spi2-core/libatk1.0-0t64_2.52.0-1build1_amd64.deb", sha256: "42c5d4b00954f17c2c3c4b866844f691eb8b6d57bf08b59203e65f12dc84a4f9" },
  { name: "libatspi2.0-0t64", url: "https://archive.ubuntu.com/ubuntu/pool/main/a/at-spi2-core/libatspi2.0-0t64_2.52.0-1build1_amd64.deb", sha256: "d686ace4080eca9c2d6ce8de69392a5ac56c846701894c0858922d4ce341a1d7" },
  { name: "libavahi-client3", url: "https://archive.ubuntu.com/ubuntu/pool/main/a/avahi/libavahi-client3_0.8-13ubuntu6.2_amd64.deb", sha256: "00609b52ea5a1a9e35fcee4bfba03b6ff743a8015649026cb9109c356762f4d9" },
  { name: "libavahi-common3", url: "https://archive.ubuntu.com/ubuntu/pool/main/a/avahi/libavahi-common3_0.8-13ubuntu6.2_amd64.deb", sha256: "edd1f7a4a21e70504d0872c429600f2e13fdff7775c0952145f1afeacede1c82" },
  { name: "libblkid1", url: "https://archive.ubuntu.com/ubuntu/pool/main/u/util-linux/libblkid1_2.39.3-9ubuntu6.6_amd64.deb", sha256: "3bcf169cd65e2539059b2287924090fc629f9bf90f595fc25465a7efe950ee82" },
  { name: "libbrotli1", url: "https://archive.ubuntu.com/ubuntu/pool/main/b/brotli/libbrotli1_1.1.0-2build2_amd64.deb", sha256: "74492419b8fda803774b8c9acef6afc5d2f9ff31782635aae212906adae7b277" },
  { name: "libbsd0", url: "https://archive.ubuntu.com/ubuntu/pool/main/libb/libbsd/libbsd0_0.12.1-1build1.1_amd64.deb", sha256: "f3857b0863ac5cfd4263e9bf6cfb1d4be88d5321e4070d5bc2b62b0949e6c86f" },
  { name: "libbz2-1.0", url: "https://archive.ubuntu.com/ubuntu/pool/main/b/bzip2/libbz2-1.0_1.0.8-5.1ubuntu0.1_amd64.deb", sha256: "36ee08b00b1ee5018b2fce02881b7d2d73c9b4e32990bde3388400d86c48126a" },
  { name: "libc6", url: "https://archive.ubuntu.com/ubuntu/pool/main/g/glibc/libc6_2.39-0ubuntu8.9_amd64.deb", sha256: "ff5557d99b51f761c4b7c92368b9cc45565eda17df9bf9eb4b134d09825008be" },
  { name: "libcairo2", url: "https://archive.ubuntu.com/ubuntu/pool/main/c/cairo/libcairo2_1.18.0-3build1_amd64.deb", sha256: "96950b306889ff6e4248bb937b0a3b56e72dacf643fe732214ce375f0f6bbb36" },
  { name: "libcap2", url: "https://archive.ubuntu.com/ubuntu/pool/main/libc/libcap2/libcap2_2.66-5ubuntu2.4_amd64.deb", sha256: "23c627c77c66552a658e62852f244f4946dc543898e0ec5428d5dc6bffde2d6a" },
  { name: "libcom-err2", url: "https://archive.ubuntu.com/ubuntu/pool/main/e/e2fsprogs/libcom-err2_1.47.0-2.4%7eexp1ubuntu4.1_amd64.deb", sha256: "7ab24d3057dabf86db8f771ad6e43f073ed86b6b950d6e8ba22cb9fe6707bbc9" },
  { name: "libcups2t64", url: "https://archive.ubuntu.com/ubuntu/pool/main/c/cups/libcups2t64_2.4.7-1.2ubuntu7.14_amd64.deb", sha256: "b815a3d936718614e403035bb4a545e1323305ea624709bff2e9d94c214f9cc4" },
  { name: "libdatrie1", url: "https://archive.ubuntu.com/ubuntu/pool/main/libd/libdatrie/libdatrie1_0.2.13-3build1_amd64.deb", sha256: "1ae164e40e413eac4fbd38ce1c6ef9591f7a03278ad9076d71fa29258727f447" },
  { name: "libdbus-1-3", url: "https://archive.ubuntu.com/ubuntu/pool/main/d/dbus/libdbus-1-3_1.14.10-4ubuntu4.1_amd64.deb", sha256: "5d630480f04b4b442300ce847a3fa705ea4d14d80ba6de91f99b51a4e4953b08" },
  { name: "libdrm2", url: "https://archive.ubuntu.com/ubuntu/pool/main/libd/libdrm/libdrm2_2.4.125-1ubuntu0.1%7e24.04.2_amd64.deb", sha256: "4d3e858dd57be617c49d87c5ddcdb35df744a4f0a559981256ae2ba174718584" },
  { name: "libegl1", url: "https://archive.ubuntu.com/ubuntu/pool/main/libg/libglvnd/libegl1_1.7.0-1build1_amd64.deb", sha256: "e549f7776216f7bd3b1c216729fb40a97a562e2eb7c563cde632b4931f9a4e57" },
  { name: "libexpat1", url: "https://archive.ubuntu.com/ubuntu/pool/main/e/expat/libexpat1_2.6.1-2ubuntu0.6_amd64.deb", sha256: "494b8e672f722130c6bca6a7bc4cc31a43ca891a31d60d868bfdd699a3c20b13" },
  { name: "libffi8", url: "https://archive.ubuntu.com/ubuntu/pool/main/libf/libffi/libffi8_3.4.6-1build1_amd64.deb", sha256: "637e6a7744de08cd331a41f4efd0d24e6ea9064843dea9d1c6ca87bdb5f038a2" },
  { name: "libflac12t64", url: "https://archive.ubuntu.com/ubuntu/pool/main/f/flac/libflac12t64_1.4.3%2bds-2.1ubuntu2_amd64.deb", sha256: "f2396692573407b2fbc92cd83148342d4aec717d42d5e24ac64c471204a0b7a9" },
  { name: "libfontconfig1", url: "https://archive.ubuntu.com/ubuntu/pool/main/f/fontconfig/libfontconfig1_2.15.0-1.1ubuntu2_amd64.deb", sha256: "a2bc05cfef021fdb84285036f98eda5ebec3c4b7a378f5aa2bdba5c4d3d8d586" },
  { name: "libfreetype6", url: "https://archive.ubuntu.com/ubuntu/pool/main/f/freetype/libfreetype6_2.13.2%2bdfsg-1ubuntu0.2_amd64.deb", sha256: "8c6d3bac5a6197fa2f48b2d56f04f3ffecaa7082eeab91b0939f97a40adc88a6" },
  { name: "libfribidi0", url: "https://archive.ubuntu.com/ubuntu/pool/main/f/fribidi/libfribidi0_1.0.13-3build1_amd64.deb", sha256: "6cd50259d39ce0dfafee2632c6268538e6a02590e77161a133e9683af346dd1d" },
  { name: "libgbm1", url: "https://archive.ubuntu.com/ubuntu/pool/main/m/mesa/libgbm1_25.2.8-0ubuntu0.24.04.4_amd64.deb", sha256: "4bfe348b456db5b445a80e0a3ffb9e9a01b91499bb86e0e568ca3634b134da7e" },
  { name: "libgcrypt20", url: "https://archive.ubuntu.com/ubuntu/pool/main/libg/libgcrypt20/libgcrypt20_1.10.3-2ubuntu0.2_amd64.deb", sha256: "957b9eeaa83cf6f2d5d5d76dbb8aa31d3297e6781d8a02fa08dcc897ae650a0b" },
  { name: "libgl1", url: "https://archive.ubuntu.com/ubuntu/pool/main/libg/libglvnd/libgl1_1.7.0-1build1_amd64.deb", sha256: "e2b2fadeb883f073b566ad1d7874f6702397514d258473e96152a89d4d502a09" },
  { name: "libglib2.0-0t64", url: "https://archive.ubuntu.com/ubuntu/pool/main/g/glib2.0/libglib2.0-0t64_2.80.0-6ubuntu3.10_amd64.deb", sha256: "ff1b650f655b36dfe202fdbae6bb02b363c7257b6dd23e4f95ab61f716190df3" },
  { name: "libglvnd0", url: "https://archive.ubuntu.com/ubuntu/pool/main/libg/libglvnd/libglvnd0_1.7.0-1build1_amd64.deb", sha256: "33f5e07c74f73c2bfb44086ae0f9e6da52acd6c104d30ffe8fd768d8253d5e82" },
  { name: "libglx0", url: "https://archive.ubuntu.com/ubuntu/pool/main/libg/libglvnd/libglx0_1.7.0-1build1_amd64.deb", sha256: "aa4953182f30abde90cb5b072e83d7286b557b325769b8686196a7bd396d8795" },
  { name: "libgcc-s1", url: "https://archive.ubuntu.com/ubuntu/pool/main/g/gcc-14/libgcc-s1_14.2.0-4ubuntu2~24.04.1_amd64.deb", sha256: "aa7fadbe33b78bcf99885318040601c550c208929565b179891d9a3cc2aa68cd" },
  { name: "libgmp10", url: "https://archive.ubuntu.com/ubuntu/pool/main/g/gmp/libgmp10_6.3.0%2bdfsg-2ubuntu6.1_amd64.deb", sha256: "285f8a505dfa8e1b33f357a9d8d3477ad35bf18c0b34771a6df4c25923f3ae0d" },
  { name: "libgnutls30t64", url: "https://archive.ubuntu.com/ubuntu/pool/main/g/gnutls28/libgnutls30t64_3.8.3-1.1ubuntu3.6_amd64.deb", sha256: "b8944756260c5ea6b7fac019745f931f905aa7a4df0763676b1b25c911b692e2" },
  { name: "libgpg-error0", url: "https://archive.ubuntu.com/ubuntu/pool/main/libg/libgpg-error/libgpg-error0_1.47-3build2.1_amd64.deb", sha256: "93654ee8180a73a0363f25c51dc673d67cbabcbecd164187b8a2deb54d007aef" },
  { name: "libgraphite2-3", url: "https://archive.ubuntu.com/ubuntu/pool/main/g/graphite2/libgraphite2-3_1.3.14-2ubuntu0.24.04.1_amd64.deb", sha256: "2413ea0f6670d6610ee7c2f550551d69fa341f4b9c78e20eb397f0d1bbe914cb" },
  { name: "libgssapi-krb5-2", url: "https://archive.ubuntu.com/ubuntu/pool/main/k/krb5/libgssapi-krb5-2_1.20.1-6ubuntu2.10_amd64.deb", sha256: "0d4a0187bcdbbe3e6a10bfa574100087d12052d0d0ef28614fd6210021c587b2" },
  { name: "libharfbuzz0b", url: "https://archive.ubuntu.com/ubuntu/pool/main/h/harfbuzz/libharfbuzz0b_8.3.0-2build2_amd64.deb", sha256: "d6f7eea2244f98aa0463a056680d4629476bf624767ede301560e24add686b5c" },
  { name: "libhogweed6t64", url: "https://archive.ubuntu.com/ubuntu/pool/main/n/nettle/libhogweed6t64_3.9.1-2.2build1.1_amd64.deb", sha256: "a9b5f7e9d49ba9060e1c933567046fbc6feab6096799cbf550b7214dc9b0f49b" },
  { name: "libidn2-0", url: "https://archive.ubuntu.com/ubuntu/pool/main/libi/libidn2/libidn2-0_2.3.7-2build1.1_amd64.deb", sha256: "46bfd10df095a23b65f58115de47a547c9a2d14627749bd0423ae78c14be77d3" },
  { name: "libk5crypto3", url: "https://archive.ubuntu.com/ubuntu/pool/main/k/krb5/libk5crypto3_1.20.1-6ubuntu2.10_amd64.deb", sha256: "273f7cc95a68d927d7f71c3e78b7717a16a8d86e646a206bae7bf797150ae9db" },
  { name: "libkeyutils1", url: "https://archive.ubuntu.com/ubuntu/pool/main/k/keyutils/libkeyutils1_1.6.3-3build1_amd64.deb", sha256: "0679f198b0128179e46cdf956fb2022c23c758664c00bc8efa0382d509683a8a" },
  { name: "libkrb5-3", url: "https://archive.ubuntu.com/ubuntu/pool/main/k/krb5/libkrb5-3_1.20.1-6ubuntu2.10_amd64.deb", sha256: "60b48c5a3233f1d8caba30d6573edc8e131911ab6d63adcd664f7cbe62708362" },
  { name: "libkrb5support0", url: "https://archive.ubuntu.com/ubuntu/pool/main/k/krb5/libkrb5support0_1.20.1-6ubuntu2.10_amd64.deb", sha256: "9224ede3246a82a845ea97652ecfae57f88e8d8f520d8a186f9157167574fb34" },
  { name: "liblz4-1", url: "https://archive.ubuntu.com/ubuntu/pool/main/l/lz4/liblz4-1_1.9.4-1build1.1_amd64.deb", sha256: "319331270d5cc52d5ebffe51c941d7b01b432bc402c2924b557209a64d4ecbad" },
  { name: "liblzma5", url: "https://archive.ubuntu.com/ubuntu/pool/main/x/xz-utils/liblzma5_5.6.1%2breally5.4.5-1ubuntu0.4_amd64.deb", sha256: "5bcf5da2339331e21d3f42a831e82c61c54c6b2f29804010e8d59abd0ae52167" },
  { name: "libmd0", url: "https://archive.ubuntu.com/ubuntu/pool/main/libm/libmd/libmd0_1.1.0-2build1.1_amd64.deb", sha256: "e5ba01d3c41f256aaf57ec59aa0554857162e3e7f97cdfbff1ed2c0e8d720ee7" },
  { name: "libmount1", url: "https://archive.ubuntu.com/ubuntu/pool/main/u/util-linux/libmount1_2.39.3-9ubuntu6.6_amd64.deb", sha256: "8f2c25589f187dacfdc5bb6be2af0aee6c2ba7b4d2edd1ca4b26753469f07aae" },
  { name: "libmp3lame0", url: "https://archive.ubuntu.com/ubuntu/pool/main/l/lame/libmp3lame0_3.100-6build1_amd64.deb", sha256: "d739e9a3565f98b8b72a9e203a9a537bd1090af6cafb94c98adf8e27f9d3fb94" },
  { name: "libmpg123-0t64", url: "https://archive.ubuntu.com/ubuntu/pool/main/m/mpg123/libmpg123-0t64_1.32.5-1ubuntu1.1_amd64.deb", sha256: "bbe32128e3358f141f9f58ef6e76a7bef3e07d09165203665d30fdc27372b418" },
  { name: "libnettle8t64", url: "https://archive.ubuntu.com/ubuntu/pool/main/n/nettle/libnettle8t64_3.9.1-2.2build1.1_amd64.deb", sha256: "6d97fbc1972633083f08f51ccab433606c97bbceb897c631c66495117ca3406f" },
  { name: "libnspr4", url: "https://archive.ubuntu.com/ubuntu/pool/main/n/nspr/libnspr4_4.35-1.1build1_amd64.deb", sha256: "e579e72d091f6c7a13f5a756c31065b15aae5b81840d61b069355aa2283c07b4" },
  { name: "libnss3", url: "https://archive.ubuntu.com/ubuntu/pool/main/n/nss/libnss3_3.98-1ubuntu0.3_amd64.deb", sha256: "e11fdf8c09a068d0f0c3fd90ed971253dfed7227cc20d3d487fd615d4771f1bb" },
  { name: "libogg0", url: "https://archive.ubuntu.com/ubuntu/pool/main/libo/libogg/libogg0_1.3.5-3build1_amd64.deb", sha256: "fbdb2fedbafb02c3f07f2c2ddeb4018b5e94e13462f93fbececdcefc06fe2ac1" },
  { name: "libopus0", url: "https://archive.ubuntu.com/ubuntu/pool/main/o/opus/libopus0_1.4-1build1_amd64.deb", sha256: "6d8da32a832e655c9603543b47a0bc90c6f60bdee0c00fe7499bd50acad566cf" },
  { name: "libp11-kit0", url: "https://archive.ubuntu.com/ubuntu/pool/main/p/p11-kit/libp11-kit0_0.25.3-4ubuntu2.2_amd64.deb", sha256: "e7c58aeac19d89f5f1492dfaa52b8623bcd56edc40983f5243ad56d94f477bf2" },
  { name: "libpango-1.0-0", url: "https://archive.ubuntu.com/ubuntu/pool/main/p/pango1.0/libpango-1.0-0_1.52.1%2bds-1build1_amd64.deb", sha256: "09dfa5c881ab273ec6bc1830adcefdc407fcd619316e68fb26ca3a23d0fc9f54" },
  { name: "libpangocairo-1.0-0", url: "https://archive.ubuntu.com/ubuntu/pool/main/p/pango1.0/libpangocairo-1.0-0_1.52.1%2bds-1build1_amd64.deb", sha256: "98cf5fc9076c2911fe20dfc1e41cd8f686a2bb5d539b1105fab18105b0db1376" },
  { name: "libpangoft2-1.0-0", url: "https://archive.ubuntu.com/ubuntu/pool/main/p/pango1.0/libpangoft2-1.0-0_1.52.1%2bds-1build1_amd64.deb", sha256: "cc6bc9d86ef5f329edacaa4895232d8a9b8f95c5cbc77c3c460a3f64cecc213d" },
  { name: "libpcre2-8-0", url: "https://archive.ubuntu.com/ubuntu/pool/main/p/pcre2/libpcre2-8-0_10.42-4ubuntu2.1_amd64.deb", sha256: "110a797a57673d3ee497a141cf988199258058c57525799c63194d81822529a0" },
  { name: "libpixman-1-0", url: "https://archive.ubuntu.com/ubuntu/pool/main/p/pixman/libpixman-1-0_0.42.2-1build1_amd64.deb", sha256: "d9c2931c4c424615eeab9dd5ae08bfc608b84e803c1d3ccddf319270db213421" },
  { name: "libpng16-16t64", url: "https://archive.ubuntu.com/ubuntu/pool/main/libp/libpng1.6/libpng16-16t64_1.6.43-5ubuntu0.7_amd64.deb", sha256: "863d6abb089b2820ceba98e6b18f06eaacc55f9b05827001e7b4021a9a7b246c" },
  { name: "libpulse0", url: "https://archive.ubuntu.com/ubuntu/pool/main/p/pulseaudio/libpulse0_16.1%2bdfsg1-2ubuntu10.1_amd64.deb", sha256: "b8d52aa6c2f74ae99e749c9f98d6ad2dbf924fd422371ac469725245cdd919fc" },
  { name: "libselinux1", url: "https://archive.ubuntu.com/ubuntu/pool/main/libs/libselinux/libselinux1_3.5-2ubuntu2.1_amd64.deb", sha256: "6abaa6c26f46ef17764c4a753e0e84de1cdadde5634fd2987621fdc617988d19" },
  { name: "libsndfile1", url: "https://archive.ubuntu.com/ubuntu/pool/main/libs/libsndfile/libsndfile1_1.2.2-1ubuntu5.24.04.1_amd64.deb", sha256: "fe2461b27e747fa88ede157ea39c6379e2101c280a730cda9c825f566a3808e5" },
  { name: "libsqlite3-0", url: "https://archive.ubuntu.com/ubuntu/pool/main/s/sqlite3/libsqlite3-0_3.45.1-1ubuntu2.8_amd64.deb", sha256: "b1190bb72359f5fcc47406aa46065eaf4f1ca208085c51224a52b04bedc0b4bb" },
  { name: "libsystemd0", url: "https://archive.ubuntu.com/ubuntu/pool/main/s/systemd/libsystemd0_255.4-1ubuntu8.18_amd64.deb", sha256: "2da3fa28302cf007075e89cdc3aabe6973916afcd62c3884b86f67b77c73a5b4" },
  { name: "libtasn1-6", url: "https://archive.ubuntu.com/ubuntu/pool/main/libt/libtasn1-6/libtasn1-6_4.19.0-3ubuntu0.24.04.2_amd64.deb", sha256: "f82c9ad142f952ea523bda5bfca7bb0802af3a50b8c0f0dd9ec18cdfa104bde7" },
  { name: "libthai0", url: "https://archive.ubuntu.com/ubuntu/pool/main/libt/libthai/libthai0_0.1.29-2build1_amd64.deb", sha256: "5ada7045c5f84a4b774e6449151800aa6470e8d01dc9d6124ef4a44ae6af5508" },
  { name: "libudev1", url: "https://archive.ubuntu.com/ubuntu/pool/main/s/systemd/libudev1_255.4-1ubuntu8.18_amd64.deb", sha256: "6de7321adcc37068f8702fe6826473662df73c36377e00f07f7acfeca2e40d4a" },
  { name: "libunistring5", url: "https://archive.ubuntu.com/ubuntu/pool/main/libu/libunistring/libunistring5_1.1-2build1.1_amd64.deb", sha256: "203d7657b5f54633fba1a9c9b784d556ef83c9f6787b3185ba55a88e07b865a3" },
  { name: "libvorbis0a", url: "https://archive.ubuntu.com/ubuntu/pool/main/libv/libvorbis/libvorbis0a_1.3.7-1build3_amd64.deb", sha256: "d704ac0a5dd7a9797a2f2dc86fc8333c9973023b98b3510dcd2f1cc00da3624d" },
  { name: "libvorbisenc2", url: "https://archive.ubuntu.com/ubuntu/pool/main/libv/libvorbis/libvorbisenc2_1.3.7-1build3_amd64.deb", sha256: "866c561fe81d4430a48c820f4e62f3cd138f4c8c7664f9203f02c1ced2eb55d4" },
  { name: "libwayland-client0", url: "https://archive.ubuntu.com/ubuntu/pool/main/w/wayland/libwayland-client0_1.22.0-2.1build1_amd64.deb", sha256: "6af0aed41d75149bea22fa468f01eb058ffe3e35ef07ff2f13fb88a90387881d" },
  { name: "libwayland-cursor0", url: "https://archive.ubuntu.com/ubuntu/pool/main/w/wayland/libwayland-cursor0_1.22.0-2.1build1_amd64.deb", sha256: "29c20da27e8e37c984cf0518635c11cd0441f4cb6a2919a9f6eee1809171d327" },
  { name: "libwayland-egl1", url: "https://archive.ubuntu.com/ubuntu/pool/main/w/wayland/libwayland-egl1_1.22.0-2.1build1_amd64.deb", sha256: "76cd17d2776428e0a0551b8f8fd954eeb3d39ca8ed2f88a38a5e4ce3ce3b2f16" },
  { name: "libx11-6", url: "https://archive.ubuntu.com/ubuntu/pool/main/libx/libx11/libx11-6_1.8.7-1ubuntu0.1_amd64.deb", sha256: "9102f73477081a9a57994c80587ca9760341f644ed51bdfa46f2248083d418b3" },
  { name: "libx11-xcb1", url: "https://archive.ubuntu.com/ubuntu/pool/main/libx/libx11/libx11-xcb1_1.8.7-1ubuntu0.1_amd64.deb", sha256: "5ce7093e58aaaf753ed0904351a4e07f209e0c282ee8ef4f5f7988d0b40dccc1" },
  { name: "libxau6", url: "https://archive.ubuntu.com/ubuntu/pool/main/libx/libxau/libxau6_1.0.9-1build6_amd64.deb", sha256: "e40d29f1d1a62393bacaedebe0da3d9006084152a9f7e5e029293f08ce1c5c80" },
  { name: "libxcb-render0", url: "https://archive.ubuntu.com/ubuntu/pool/main/libx/libxcb/libxcb-render0_1.15-1ubuntu2_amd64.deb", sha256: "7d83a0668b1a693b5ea2e496206e8371fb6beda4c54a2b4b3902005915c272c5" },
  { name: "libxcb-shm0", url: "https://archive.ubuntu.com/ubuntu/pool/main/libx/libxcb/libxcb-shm0_1.15-1ubuntu2_amd64.deb", sha256: "229d1280d459f1ba44c22939d3f9b61d9d20932d9a646b3fe4ce50be4cdf2325" },
  { name: "libxcb-xkb1", url: "https://archive.ubuntu.com/ubuntu/pool/main/libx/libxcb/libxcb-xkb1_1.15-1ubuntu2_amd64.deb", sha256: "53bc0a58834c981fa8ce5c3ab6195387e5c8a417039d82cc7a8b49724fa53228" },
  { name: "libxcb1", url: "https://archive.ubuntu.com/ubuntu/pool/main/libx/libxcb/libxcb1_1.15-1ubuntu2_amd64.deb", sha256: "e1c6611d11ad7398326f1bf028afc34c3b14c51d917a3426b966ed4b9687fa58" },
  { name: "libxcomposite1", url: "https://archive.ubuntu.com/ubuntu/pool/main/libx/libxcomposite/libxcomposite1_0.4.5-1build3_amd64.deb", sha256: "a12d5d9ae70b798cbbf284080eae32b87367561fc9c24492f641b8860ac0f308" },
  { name: "libxcursor1", url: "https://archive.ubuntu.com/ubuntu/pool/main/libx/libxcursor/libxcursor1_1.2.1-1build1_amd64.deb", sha256: "1a4beee621454e42fe0d2f4e1633611126e43d891f0aec28e4a06744f6e9f04d" },
  { name: "libxdamage1", url: "https://archive.ubuntu.com/ubuntu/pool/main/libx/libxdamage/libxdamage1_1.1.6-1build1_amd64.deb", sha256: "6891faf325e996ebd28ef53ebb9c043dc96f67327500490affc3e89d366d35ed" },
  { name: "libxdmcp6", url: "https://archive.ubuntu.com/ubuntu/pool/main/libx/libxdmcp/libxdmcp6_1.1.3-0ubuntu6_amd64.deb", sha256: "bcd336fce11ce2a45f34d0f95e6980af22529f22147e8f98c156e5cee8ee42bb" },
  { name: "libxext6", url: "https://archive.ubuntu.com/ubuntu/pool/main/libx/libxext/libxext6_1.3.4-1build2_amd64.deb", sha256: "45783969a9ece9d7b7b733b8c60981584c53c6bc5ee3b42d295d2f80d1285679" },
  { name: "libxfixes3", url: "https://archive.ubuntu.com/ubuntu/pool/main/libx/libxfixes/libxfixes3_6.0.0-2build1_amd64.deb", sha256: "0ee1015cccd063249e01c0cd0bf45f513c8ac9a1e5e485070c12e69192455e4a" },
  { name: "libxi6", url: "https://archive.ubuntu.com/ubuntu/pool/main/libx/libxi/libxi6_1.8.1-1build1_amd64.deb", sha256: "0ea7acb5e8a8ce4d6653b30e03a319bfe136db7bfb5ee7cad34c2aa1272ea8d9" },
  { name: "libxinerama1", url: "https://archive.ubuntu.com/ubuntu/pool/main/libx/libxinerama/libxinerama1_1.1.4-3build1_amd64.deb", sha256: "c8c93a3efdbb06e314f41bf48af4ca3652e4a3826bab5b9e00887660e619f239" },
  { name: "libxkbcommon-x11-0", url: "https://archive.ubuntu.com/ubuntu/pool/main/libx/libxkbcommon/libxkbcommon-x11-0_1.6.0-1build1_amd64.deb", sha256: "3befe840ce612ddfc0998d8610c6eed295726722a78e75cd08520bbd75065a23" },
  { name: "libxkbcommon0", url: "https://archive.ubuntu.com/ubuntu/pool/main/libx/libxkbcommon/libxkbcommon0_1.6.0-1build1_amd64.deb", sha256: "2b9caeb423efb540296a1cb20b872cc630c23908407ecb5c1c787a617622d664" },
  { name: "libxrandr2", url: "https://archive.ubuntu.com/ubuntu/pool/main/libx/libxrandr/libxrandr2_1.5.2-2build1_amd64.deb", sha256: "f2955a5e594f5724b58ad241d9231ea191cb36574a0d5e5ca6b661cd41d6256d" },
  { name: "libxrender1", url: "https://archive.ubuntu.com/ubuntu/pool/main/libx/libxrender/libxrender1_0.9.10-1.1build1_amd64.deb", sha256: "d70bd831aebe8d4834b5dd2ed98df26dd6bd27f1042c47543bd7f66df1ae22ea" },
  { name: "libxss1", url: "https://archive.ubuntu.com/ubuntu/pool/main/libx/libxss/libxss1_1.2.3-1build3_amd64.deb", sha256: "0ac60a2cc034ccc4bf4e2f846f38110469d7ae43b47e808d67aafc538bc3695e" },
  { name: "libxtst6", url: "https://archive.ubuntu.com/ubuntu/pool/main/libx/libxtst/libxtst6_1.2.3-1.1ubuntu0.1_amd64.deb", sha256: "2340688e034d5dd3f5ec180b1bed32407de16db1679ce85cec3e2d34625f50dd" },
  { name: "libzstd1", url: "https://archive.ubuntu.com/ubuntu/pool/main/libz/libzstd/libzstd1_1.5.5%2bdfsg2-2build1.1_amd64.deb", sha256: "dfcf25061e07aad7efd3f4f880ba5ad4d4d09ebe7fc8cc77ab6b8a161d6d4727" },
  { name: "zlib1g", url: "https://archive.ubuntu.com/ubuntu/pool/main/z/zlib/zlib1g_1.3.dfsg-3.1ubuntu2.3_amd64.deb", sha256: "376249c8de139568221dbb242318cc8cb8f02299e3a62b7432948e1754fbddf9" },
]);

export interface FontAsset extends PinnedAsset {
  file: string;
}

/**
 * Latin and CJK faces from google/fonts at one pinned commit. The CJK variable
 * fonts carry Simplified Chinese, Japanese, and Korean coverage; Latin is a
 * separate variable face so the browser's default sans-serif resolves.
 */
export const FONT_ASSETS: readonly FontAsset[] = Object.freeze([
  {
    name: "noto-sans",
    file: "NotoSans[wdth,wght].ttf",
    url: "https://raw.githubusercontent.com/google/fonts/e7db6ca603fd4862010383ff17ffd6cc4ffac1c0/ofl/notosans/NotoSans%5Bwdth,wght%5D.ttf",
    sha256: "bfb7bb691513f12e734dc346c03a03f784912432d7e3fa8e56efcf906fe86b3d",
  },
  {
    name: "noto-sans-sc",
    file: "NotoSansSC[wght].ttf",
    url: "https://raw.githubusercontent.com/google/fonts/e7db6ca603fd4862010383ff17ffd6cc4ffac1c0/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf",
    sha256: "a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da",
  },
  {
    name: "noto-sans-jp",
    file: "NotoSansJP[wght].ttf",
    url: "https://raw.githubusercontent.com/google/fonts/e7db6ca603fd4862010383ff17ffd6cc4ffac1c0/ofl/notosansjp/NotoSansJP%5Bwght%5D.ttf",
    sha256: "c2f3b4d463500a2ddcd3849cded1fceeb9fd6d1c32e6cbecd568453ba50fc68f",
  },
  {
    name: "noto-sans-kr",
    file: "NotoSansKR[wght].ttf",
    url: "https://raw.githubusercontent.com/google/fonts/e7db6ca603fd4862010383ff17ffd6cc4ffac1c0/ofl/notosanskr/NotoSansKR%5Bwght%5D.ttf",
    sha256: "194018e6b2b293a7964f037b25c0249ce1418bc9ab3c971060a03aa57861e252",
  },
]);

export const BROWSER_ASSETS_RELEASE = "chrome-for-testing-156.0.8078.47-linux64";

const READY_FILE = ".omarchy-bot-assets";
const LOADER = "ld-linux-x86-64.so.2";

export interface BotComputerAssetSupply {
  ensureFonts(): Promise<{ fontConfigFile: string }>;
  ensureBrowser(): Promise<{ browserBin: string }>;
}

export interface PortableBotComputerAssetsOptions {
  profileDir: string;
  fontDir?: string;
  browserPackDir?: string;
  fonts?: readonly FontAsset[];
}

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isExecutableFile(candidate: string): boolean {
  try {
    const mode = statSync(candidate).mode;
    return statSync(candidate).isFile() && (mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

async function sha256(filePath: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of createReadStream(filePath)) hasher.update(chunk);
  return hasher.digest("hex");
}


/**
 * A font configuration that reads only the supplied runtime fonts and keeps
 * its cache in the profile, without searching host font directories.
 */
function fontConfig(fontDir: string, cacheDir: string): string {
  const xml = (value: string): string =>
    value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const alias = (family: string): string => [
    "  <match target=\"pattern\">",
    `    <test name=\"family\"><string>${family}</string></test>`,
    "    <edit name=\"family\" mode=\"assign\" binding=\"strong\">",
    "      <string>Noto Sans</string>",
    "    </edit>",
    "  </match>",
  ].join("\n");
  return [
    "<?xml version=\"1.0\"?>",
    "<!DOCTYPE fontconfig SYSTEM \"urn:fontconfig:fonts.dtd\">",
    "<fontconfig>",
    `  <dir>${xml(fontDir)}</dir>`,
    `  <cachedir>${xml(cacheDir)}</cachedir>`,
    alias("sans-serif"),
    alias("serif"),
    alias("monospace"),
    "</fontconfig>",
    "",
  ].join("\n");
}

/** Resolves installed browser assets and verifies runtime fonts without network access. */
export class PortableBotComputerAssets implements BotComputerAssetSupply {
  readonly #profileDir: string;
  readonly #fontDir: string | undefined;
  readonly #browserPackDir: string | undefined;
  readonly #fonts: readonly FontAsset[];
  #fontsInFlight: Promise<{ fontConfigFile: string }> | undefined;
  #browserInFlight: Promise<{ browserBin: string }> | undefined;

  constructor(options: PortableBotComputerAssetsOptions) {
    this.#profileDir = options.profileDir;
    this.#fontDir = options.fontDir;
    this.#browserPackDir = options.browserPackDir;
    this.#fonts = options.fonts ?? FONT_ASSETS;
  }

  ensureFonts(): Promise<{ fontConfigFile: string }> {
    if (this.#fontsInFlight !== undefined) return this.#fontsInFlight;
    const provision = this.#provisionFonts().finally(() => {
      if (this.#fontsInFlight === provision) this.#fontsInFlight = undefined;
    });
    this.#fontsInFlight = provision;
    return provision;
  }

  ensureBrowser(): Promise<{ browserBin: string }> {
    if (this.#browserInFlight !== undefined) return this.#browserInFlight;
    const provision = this.#provisionBrowser().finally(() => {
      if (this.#browserInFlight === provision) this.#browserInFlight = undefined;
    });
    this.#browserInFlight = provision;
    return provision;
  }

  get #assetsDir(): string {
    return path.join(this.#profileDir, "assets");
  }

  async #provisionFonts(): Promise<{ fontConfigFile: string }> {
    const fontDir = this.#fontDir === undefined ? undefined : path.resolve(this.#fontDir);
    let isDirectory = false;
    try {
      isDirectory = fontDir !== undefined && statSync(fontDir).isDirectory();
    } catch {
      // Report the supplied directory rather than a missing child font.
    }
    if (fontDir === undefined || !isDirectory) {
      throw new Error(`Bot Computer font directory is unavailable: ${fontDir ?? "<fontDir not configured>"}`);
    }
    for (const font of this.#fonts) {
      const file = path.join(fontDir, font.file);
      if (!isFile(file)) throw new Error(`Bot Computer font file is unavailable: ${file}`);
      const received = await sha256(file);
      if (received !== font.sha256) {
        throw new Error(`Bot Computer font checksum mismatch at ${file} (expected ${font.sha256}, received ${received})`);
      }
    }
    const cacheDir = path.join(this.#assetsDir, "font-cache");
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    const fontConfigFile = path.join(this.#assetsDir, "fonts.conf");
    const config = fontConfig(fontDir, cacheDir);
    if (!isFile(fontConfigFile) || readFileSync(fontConfigFile, "utf8") !== config) {
      writeFileSync(fontConfigFile, config, { mode: 0o600 });
    }
    return { fontConfigFile };
  }

  async #provisionBrowser(): Promise<{ browserBin: string }> {
    const bundle = this.#browserPackDir;
    if (bundle !== undefined) {
      const browserBin = path.join(bundle, "browser");
      try {
        if (readFileSync(path.join(bundle, READY_FILE), "utf8") === `${BROWSER_ASSETS_RELEASE}\n`
          && isExecutableFile(browserBin)
          && isExecutableFile(path.join(bundle, "chrome-linux64", "chrome"))
          && isExecutableFile(path.join(bundle, "libs", LOADER))) return { browserBin };
      } catch {}
    }
    throw new Error("No usable host browser or installed browser pack. Run omarchy-bot install --with-browser (with your runtime --archive and --checksum).");
  }
}
