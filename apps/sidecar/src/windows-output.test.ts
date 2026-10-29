import { expect, test } from "bun:test";
import { decodePowerShellDiagnostics } from "./windows-output.ts";

const progress = '<Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T><T>System.Object</T></TN><MS><I64 N="SourceId">1</I64><PR N="Record"><AV>Preparing modules for first use.</AV><AI>0</AI><Nil /><PI>-1</PI><PC>-1</PC><T>Completed</T><SR>-1</SR><SD> </SD></PR></MS></Obj>';
const clixml = (records: string) => `#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">${records}</Objs>`;

test("CI first-use progress disappears while serialized warning/error diagnostics remain readable", () => {
  expect(decodePowerShellDiagnostics(clixml(progress))).toBe("");
  const stderr = clixml(`${progress}<S S="warning">warning &lt;sentinel&gt; &amp; λ</S><S S="Error">error &lt;sentinel&gt; &amp; λ_x000D__x000A_</S><S S="Error">At line:4 char:1_x000D__x000A_</S>`);
  expect(decodePowerShellDiagnostics(stderr)).toBe("warning <sentinel> & λ\nerror <sentinel> & λ\r\nAt line:4 char:1\r\n");
  expect(decodePowerShellDiagnostics(clixml('<S S="warning">literal _x005F_x000D_ &amp;lt; &#x3BB; _xD83D__xDE00_</S>'))).toBe("literal _x000D_ &lt; λ 😀\n");
});

test("plain, malformed and unrecognized diagnostics are preserved", () => {
  for (const text of ["native <error> & _x000D_\r\n", "<Objs><S>user XML</S></Objs>", "#< CLIXML\n<Objs>", clixml('<S S="Error">broken &unknown;</S>'), clixml('<Obj S="Error"><ToString>unknown shape</ToString></Obj>')]) {
    expect(decodePowerShellDiagnostics(text)).toBe(text);
  }
  const wrapped = `native before\n${clixml(progress)}\nnative after\n`;
  expect(decodePowerShellDiagnostics(wrapped)).toBe("native before\n\nnative after\n");
});
