import { exec } from "node:child_process";

export const properties = {
  from: {
    images: ["svg"],
  },
  to: {
    images: ["png"],
  },
};

export function convert(
  filePath: string,
  fileType: string,
  convertTo: string,
  targetPath: string,
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  options?: any,
): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(`resvg "${filePath}" "${targetPath}"`, (error, stdout, stderr) => {
      if (error) {
        reject(`error: ${error}`);
      }

      if (stdout) {
        console.log(`stdout: ${stdout}`);
      }

      if (stderr) {
        console.error(`stderr: ${stderr}`);
      }

      resolve("success");
    });
  });
}
