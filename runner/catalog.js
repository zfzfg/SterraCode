import fs from "node:fs/promises";
export const LOCK = JSON.parse(
  await fs.readFile(
    new URL("./catalog/versions.lock", import.meta.url),
    "utf8",
  ),
);
export const PROGRAMS = [
  {
    id: "javascript",
    name: "Node.js",
    description: "JavaScript und Runner-Steuerung",
    sizeMB: 0,
    base: true,
  },
  {
    id: "bash",
    name: "Bash",
    description: "Terminal und Bash-Skripte",
    sizeMB: 0,
    base: true,
  },
  {
    id: "git",
    name: "Git",
    description: "Versionsverwaltung",
    sizeMB: 0,
    base: true,
  },
  {
    id: "python",
    name: "Python 3",
    description: "Python-Skripte",
    sizeMB: 80,
    packages: ["python3"],
  },
  {
    id: "java",
    name: "Java JDK 17",
    description: "Java mit javac und java",
    sizeMB: 400,
    packages: ["openjdk-17-jdk-headless"],
  },
  {
    id: "go",
    name: "Go",
    description: "Go-Compiler und Standardbibliothek",
    sizeMB: 550,
    upstream: true,
    packages: [],
  },
  {
    id: "rust",
    name: "Rust",
    description: "Rust-Compiler, Cargo und Standardbibliothek",
    sizeMB: 1000,
    upstream: true,
    packages: ["gcc", "libc6-dev"],
  },
  {
    id: "cpp",
    name: "C/C++",
    description: "GNU C++ mit Headern und Linker",
    sizeMB: 500,
    packages: ["g++"],
  },
  {
    id: "csharp",
    name: ".NET SDK 8",
    description: "C# kompilieren und ausführen",
    sizeMB: 1500,
    packages: ["dotnet-sdk-8.0"],
    microsoft: true,
  },
  {
    id: "lua",
    name: "Lua 5.4",
    description: "Lua-Skripte",
    sizeMB: 5,
    packages: ["lua5.4"],
  },
].map((program) => ({
  ...program,
  language: program.id === "git" ? null : program.id,
  base: Boolean(program.base),
}));
