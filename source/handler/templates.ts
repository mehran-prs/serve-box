// source/handler/templates.ts
// HTML templates for directory listing and error pages.

interface FileEntry {
  type: 'file' | 'folder' | 'directory';
  base: string;
  relative: string;
  title: string;
  ext: string;
  size?: string;
}

interface DirectorySpec {
  files: FileEntry[];
  directory: string;
  paths: { name: string; url: string }[];
}

interface ErrorSpec {
  statusCode: number;
  message: string;
}

const encodeHTML = (code: string): string => {
  const encodeHTMLRules: Record<string, string> = {
    '&': '&#38;',
    '<': '&#60;',
    '>': '&#62;',
    '"': '&#34;',
    "'": '&#39;',
    '/': '&#47;',
  };
  const matchHTML = /&(?!#?\w+;)|<|>|"|'|\//g;
  return code
    ? code.toString().replace(matchHTML, (m) => encodeHTMLRules[m] ?? m)
    : '';
};

export const directoryTemplate = (spec: DirectorySpec): string => {
  const { files, directory, paths } = spec;

  const pathLinks = paths
    .map(
      (p, i) =>
        `<a href="/${encodeHTML(p.url)}">${i > 0 ? '<i>/</i>' : ''}${encodeHTML(
          p.name,
        )}</a>`,
    )
    .join('');

  const fileItems = files
    .map((file) => {
      const className =
        file.type === 'folder' || file.type === 'directory'
          ? 'folder'
          : `file ${file.ext}`;
      return `<li><a href="${encodeHTML(file.relative)}" title="${encodeHTML(
        file.title,
      )}" class="${className}">${encodeHTML(file.base)}</a></li>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Files within ${encodeHTML(directory)}</title>
  <style>
    body { margin: 0; padding: 30px; background: #fff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", "Oxygen", "Ubuntu", "Cantarell", "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif; -webkit-font-smoothing: antialiased; }
    main { max-width: 920px; }
    header { display: flex; justify-content: space-between; flex-wrap: wrap; align-items: center; gap: 10px; }
    h1 { font-size: 18px; font-weight: 500; margin-top: 0; color: #000; }
    header h1 a { font-size: 18px; font-weight: 500; margin-top: 0; color: #000; }
    h1 i { font-style: normal; }
    ul { margin: 0 0 0 -2px; padding: 20px 0 0 0; }
    ul li { list-style: none; font-size: 14px; display: flex; justify-content: space-between; }
    a { text-decoration: none; }
    ul a { color: #000; padding: 10px 5px; margin: 0 -5px; white-space: nowrap; overflow: hidden; display: block; width: 100%; text-overflow: ellipsis; }
    header a { color: #0076FF; font-size: 11px; font-weight: 400; display: inline-block; line-height: 20px; }
    svg { height: 13px; vertical-align: text-bottom; }
    ul a::before { display: inline-block; vertical-align: middle; margin-right: 10px; width: 24px; text-align: center; line-height: 12px; }
    ul a.file::before { content: url("data:image/svg+xml;utf8,<svg width='15' height='19' fill='none' xmlns='http://www.w3.org/2000/svg'><path d='M10 8C8.34 8 7 6.66 7 5V1H3c-1.1 0-2 .9-2 2v13c0 1.1.9 2 2 2h9c1.1 0 2-.9 2-2V8h-4zM8 5c0 1.1.9 2 2 2h3.59L8 1.41V5zM3 0h5l7 7v9c0 1.66-1.34 3-3 3H3c-1.66 0-3-1.34-3-3V3c0-1.66 1.34-3 3-3z' fill='black'/></svg>"); }
    ul a:hover { text-decoration: underline; }
    ul a.folder::before { content: url("data:image/svg+xml;utf8,<svg width='20' height='16' fill='none' xmlns='http://www.w3.org/2000/svg'><path d='M18.784 3.87a1.565 1.565 0 0 0-.565-.356V2.426c0-.648-.523-1.171-1.15-1.171H8.996L7.908.25A.89.89 0 0 0 7.302 0H2.094C1.445 0 .944.523.944 1.171v2.3c-.21.085-.398.21-.565.356a1.348 1.348 0 0 0-.377 1.004l.398 9.83C.42 15.393 1.048 16 1.8 16h15.583c.753 0 1.36-.586 1.4-1.339l.398-9.83c.021-.313-.125-.69-.397-.962zM1.843 3.41V1.191c0-.146.104-.272.25-.272H7.26l1.234 1.088c.083.042.167.104.293.104h8.282c.125 0 .25.126.25.272V3.41H1.844zm15.54 11.712H1.78a.47.47 0 0 1-.481-.46l-.397-9.83c0-.147.041-.252.125-.356a.504.504 0 0 1 .377-.147H17.78c.125 0 .272.063.377.147.083.083.125.209.125.334l-.418 9.83c-.021.272-.23.482-.481.482z' fill='black'/></svg>"); }
    ul a.file.gif::before, ul a.file.jpg::before, ul a.file.png::before, ul a.file.svg::before { content: url("data:image/svg+xml;utf8,<svg width='16' height='16' viewBox='0 0 80 80' xmlns='http://www.w3.org/2000/svg' fill='none' stroke='black' stroke-width='5' stroke-linecap='round' stroke-linejoin='round'><rect x='6' y='6' width='68' height='68' rx='5' ry='5'/><circle cx='24' cy='24' r='8'/><path d='M73 49L59 34 37 52m16 20L27 42 7 58'/></svg>"); }
    ::selection { background-color: #79FFE1; color: #000; }
    ::-moz-selection { background-color: #79FFE1; color: #000; }
    @media (min-width: 768px) { ul { display: flex; flex-wrap: wrap; } ul li { width: 230px; padding-right: 20px; } }
    @media (min-width: 992px) { body { padding: 45px; } h1, header h1 a { font-size: 15px; } ul li { font-size: 13px; box-sizing: border-box; justify-content: flex-start; } }

    /* Upload form styles */
    .upload-form { display: flex; align-items: center; gap: 10px; }
    .upload-form input[type="file"] { display: none; }
    .upload-btn { background: #0076FF; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 500; }
    .upload-btn:hover { background: #0066DD; }
    .upload-btn:disabled { background: #ccc; cursor: not-allowed; }
    .upload-status { font-size: 12px; color: #666; }
    .upload-status.error { color: #e00; }
    .upload-status.success { color: #0a0; }
    .upload-progress { width: 100px; height: 6px; background: #e0e0e0; border-radius: 3px; overflow: hidden; display: none; }
    .upload-progress-bar { height: 100%; background: #0076FF; width: 0%; transition: width 0.1s; }

    /* QR code styles */
    .qr-container { position: fixed; bottom: 20px; right: 20px; background: #fff; padding: 10px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
    .qr-container canvas { display: block; }
    .qr-label { font-size: 10px; color: #666; text-align: center; margin-top: 5px; }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>${pathLinks}</h1>
      <div class="upload-form">
        <input type="file" id="file-input" />
        <button class="upload-btn" id="upload-btn" onclick="document.getElementById('file-input').click()">Upload File</button>
        <span class="upload-status" id="upload-status"></span>
        <div class="upload-progress" id="upload-progress"><div class="upload-progress-bar" id="upload-progress-bar"></div></div>
      </div>
    </header>
    <ul>${fileItems}</ul>
  </main>
  <div class="qr-container">
    <canvas id="qr-code"></canvas>
    <div class="qr-label">Scan to open</div>
  </div>
  <script>
    const fileInput = document.getElementById('file-input');
    const uploadBtn = document.getElementById('upload-btn');
    const uploadStatus = document.getElementById('upload-status');
    const uploadProgress = document.getElementById('upload-progress');
    const uploadProgressBar = document.getElementById('upload-progress-bar');
    let currentXhr = null;

    const resetUploadUI = () => {
      uploadProgress.style.display = 'none';
      uploadProgressBar.style.width = '0%';
      uploadBtn.textContent = 'Upload File';
      uploadBtn.onclick = () => fileInput.click();
      fileInput.value = '';
      currentXhr = null;
    };

    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      if (!file) return;

      uploadStatus.textContent = '';
      uploadStatus.className = 'upload-status';
      uploadProgress.style.display = 'block';
      uploadProgressBar.style.width = '0%';
      uploadBtn.textContent = 'Cancel Upload';
      uploadBtn.onclick = () => {
        if (currentXhr) {
          currentXhr.abort();
          resetUploadUI();
          uploadStatus.textContent = 'Upload cancelled';
          uploadStatus.className = 'upload-status';
        }
      };

      const formData = new FormData();
      formData.append('file', file);

      const xhr = new XMLHttpRequest();
      currentXhr = xhr;
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const percent = Math.round((e.loaded / e.total) * 100);
          uploadProgressBar.style.width = percent + '%';
        }
      };
      xhr.onload = () => {
        resetUploadUI();
        try {
          const result = JSON.parse(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300) {
            uploadStatus.textContent = 'Upload successful!';
            uploadStatus.className = 'upload-status success';
            setTimeout(() => location.reload(), 1000);
          } else {
            uploadStatus.textContent = result.error || 'Upload failed';
            uploadStatus.className = 'upload-status error';
          }
        } catch (err) {
          uploadStatus.textContent = 'Upload failed';
          uploadStatus.className = 'upload-status error';
        }
      };
      xhr.onerror = () => {
        resetUploadUI();
        uploadStatus.textContent = 'Upload failed';
        uploadStatus.className = 'upload-status error';
      };
      xhr.open('POST', '/__upload');
      xhr.send(formData);
    });

    // QR Code generation (minimal inline implementation)
    (function() {
      const canvas = document.getElementById('qr-code');
      const url = window.location.href;
      const size = 100;
      
      // Load qrcode-generator from CDN
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js';
      script.onload = function() {
        const qr = qrcode(0, 'M');
        qr.addData(url);
        qr.make();
        
        const ctx = canvas.getContext('2d');
        const moduleCount = qr.getModuleCount();
        const cellSize = size / moduleCount;
        canvas.width = size;
        canvas.height = size;
        
        for (let row = 0; row < moduleCount; row++) {
          for (let col = 0; col < moduleCount; col++) {
            ctx.fillStyle = qr.isDark(row, col) ? '#000' : '#fff';
            ctx.fillRect(col * cellSize, row * cellSize, cellSize, cellSize);
          }
        }
      };
      document.head.appendChild(script);
    })();
  </script>
</body>
</html>`;
};

export const errorTemplate = (spec: ErrorSpec): string => {
  const { statusCode, message } = spec;
  return `<!DOCTYPE html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no"/>
  <style>
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", "Oxygen", "Ubuntu", "Cantarell", "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif; cursor: default; -webkit-user-select: none; -moz-user-select: none; -ms-user-select: none; user-select: none; -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; position: absolute; top: 0; left: 0; right: 0; bottom: 0; display: flex; flex-direction: column; }
    main, aside, section { display: flex; justify-content: center; align-items: center; flex-direction: column; }
    main { height: 100%; }
    section span { font-size: 24px; font-weight: 500; display: block; border-bottom: 1px solid #EAEAEA; text-align: center; padding-bottom: 20px; width: 100px; }
    section p { font-size: 14px; font-weight: 400; }
    section span + p { margin: 20px 0 0 0; }
    @media (min-width: 768px) { section { height: 40px; flex-direction: row; } section span, section p { height: 100%; line-height: 40px; } section span { border-bottom: 0; border-right: 1px solid #EAEAEA; padding: 0 20px 0 0; width: auto; } section span + p { margin: 0; padding-left: 20px; } }
  </style>
</head>
<body>
  <main>
    <section>
      <span>${statusCode}</span>
      <p>${message}</p>
    </section>
  </main>
</body>`;
};
