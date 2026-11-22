using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;

namespace SwiftDropCapture
{
    public static class Program
    {
        private const int SM_CXSCREEN = 0;
        private const int SM_CYSCREEN = 1;
        private const int SRCCOPY = 0x00CC0020;
        private const int COLORONCOLOR = 3;
        private const int CURSOR_SHOWING = 0x00000001;

        private const int SLOT_COUNT = 6;
        private const int WORKER_COUNT = 4;

        private const byte FLAG_KEYFRAME = 0;
        private const byte FLAG_DELTA = 1;
        private const byte FLAG_REST_HD = 2;
        private const byte FLAG_MOTION = 4;
        private const byte FLAG_DXGI = 0x80;

        private const int DXGI_ERROR_WAIT_TIMEOUT = unchecked((int)0x887A0027);
        private const int DXGI_ERROR_ACCESS_LOST = unchecked((int)0x887A0026);
        private const int DXGI_ERROR_NOT_FOUND = unchecked((int)0x887A0002);
        private const int DXGI_ERROR_SESSION_DISCONNECTED = unchecked((int)0x887A0028);

        private const uint DXGI_FORMAT_B8G8R8A8_UNORM = 87;
        private const uint DXGI_FORMAT_B8G8R8X8_UNORM = 88;
        private const uint DXGI_FORMAT_R8G8B8A8_UNORM = 28;
        private const uint D3D11_USAGE_DEFAULT = 0;
        private const uint D3D11_USAGE_STAGING = 3;
        private const uint D3D11_CPU_ACCESS_READ = 0x20000;
        private const uint D3D11_MAP_READ = 1;
        private const uint D3D11_CREATE_DEVICE_BGRA_SUPPORT = 0x20;
        private const uint D3D11_SDK_VERSION = 7;

        private static readonly Guid IID_IDXGIFactory1 = new Guid("770aae78-f26f-4dba-a829-253c83d1b387");
        private static readonly Guid IID_IDXGIOutput1 = new Guid("00cddea8-939b-4b83-a340-a685226666cc");
        private static readonly Guid IID_ID3D11Texture2D = new Guid("6f15aaf2-d208-4e89-9ab4-489535d34f9c");

        [StructLayout(LayoutKind.Sequential)]
        private struct POINT
        {
            public int x;
            public int y;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct CURSORINFO
        {
            public int cbSize;
            public int flags;
            public IntPtr hCursor;
            public POINT ptScreenPos;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ICONINFO
        {
            public bool fIcon;
            public int xHotspot;
            public int yHotspot;
            public IntPtr hbmMask;
            public IntPtr hbmColor;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct BITMAPINFOHEADER
        {
            public uint biSize;
            public int biWidth;
            public int biHeight;
            public ushort biPlanes;
            public ushort biBitCount;
            public uint biCompression;
            public uint biSizeImage;
            public int biXPelsPerMeter;
            public int biYPelsPerMeter;
            public uint biClrUsed;
            public uint biClrImportant;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct BITMAPINFO
        {
            public BITMAPINFOHEADER bmiHeader;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct DXGI_ADAPTER_DESC1
        {
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
            public string Description;
            public uint VendorId;
            public uint DeviceId;
            public uint SubSysId;
            public uint Revision;
            public UIntPtr DedicatedVideoMemory;
            public UIntPtr DedicatedSystemMemory;
            public UIntPtr SharedSystemMemory;
            public long AdapterLuid;
            public uint Flags;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct DXGI_OUTDUPL_FRAME_INFO
        {
            public long LastPresentTime;
            public long LastMouseUpdateTime;
            public uint AccumulatedFrames;
            public int RectsCoalesced;
            public int ProtectedContentMaskedOut;
            public int PointerX;
            public int PointerY;
            public int PointerVisible;
            public uint TotalMetadataBufferSize;
            public uint PointerShapeBufferSize;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct D3D11_TEXTURE2D_DESC
        {
            public uint Width;
            public uint Height;
            public uint MipLevels;
            public uint ArraySize;
            public uint Format;
            public uint SampleCount;
            public uint SampleQuality;
            public uint Usage;
            public uint BindFlags;
            public uint CPUAccessFlags;
            public uint MiscFlags;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct D3D11_MAPPED_SUBRESOURCE
        {
            public IntPtr pData;
            public uint RowPitch;
            public uint DepthPitch;
        }

        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();

        [DllImport("user32.dll")]
        private static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);

        [DllImport("user32.dll")]
        private static extern int GetSystemMetrics(int nIndex);

        [DllImport("user32.dll")]
        private static extern IntPtr GetDC(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

        [DllImport("user32.dll")]
        private static extern bool GetCursorInfo(ref CURSORINFO pci);

        [DllImport("user32.dll")]
        private static extern IntPtr CopyIcon(IntPtr hIcon);

        [DllImport("user32.dll")]
        private static extern bool GetIconInfo(IntPtr hIcon, out ICONINFO piconinfo);

        [DllImport("user32.dll")]
        private static extern bool DrawIconEx(IntPtr hdc, int xLeft, int yTop, IntPtr hIcon, int cxWidth, int cyWidth, int istepIfAniCur, IntPtr hbrFlickerFreeDraw, int diFlags);

        [DllImport("user32.dll")]
        private static extern bool DestroyIcon(IntPtr hIcon);

        [DllImport("gdi32.dll")]
        private static extern IntPtr CreateCompatibleDC(IntPtr hdc);

        [DllImport("gdi32.dll")]
        private static extern bool DeleteDC(IntPtr hdc);

        [DllImport("gdi32.dll")]
        private static extern IntPtr SelectObject(IntPtr hdc, IntPtr hgdiobj);

        [DllImport("gdi32.dll")]
        private static extern bool DeleteObject(IntPtr hObject);

        [DllImport("gdi32.dll")]
        private static extern IntPtr CreateDIBSection(IntPtr hdc, ref BITMAPINFO pbmi, uint iUsage, out IntPtr ppvBits, IntPtr hSection, uint dwOffset);

        [DllImport("gdi32.dll", SetLastError = true)]
        private static extern bool BitBlt(IntPtr hdcDest, int nXDest, int nYDest, int nWidth, int nHeight, IntPtr hdcSrc, int nXSrc, int nYSrc, int dwRop);

        [DllImport("gdi32.dll", SetLastError = true)]
        private static extern bool StretchBlt(IntPtr hdcDest, int nXOriginDest, int nYOriginDest, int nWidthDest, int nHeightDest, IntPtr hdcSrc, int nXOriginSrc, int nYOriginSrc, int nWidthSrc, int nHeightSrc, int dwRop);

        [DllImport("gdi32.dll")]
        private static extern int SetStretchBltMode(IntPtr hdc, int iStretchMode);

        [DllImport("gdi32.dll")]
        private static extern bool GdiFlush();

        [DllImport("winmm.dll")]
        private static extern uint timeBeginPeriod(uint uMilliseconds);

        [DllImport("winmm.dll")]
        private static extern uint timeEndPeriod(uint uMilliseconds);

        [DllImport("dxgi.dll", CallingConvention = CallingConvention.StdCall)]
        private static extern int CreateDXGIFactory1(ref Guid riid, out IntPtr ppFactory);

        [DllImport("d3d11.dll", CallingConvention = CallingConvention.StdCall)]
        private static extern int D3D11CreateDevice(
            IntPtr pAdapter,
            int DriverType,
            IntPtr Software,
            uint Flags,
            [In] int[] pFeatureLevels,
            uint FeatureLevels,
            uint SDKVersion,
            out IntPtr ppDevice,
            out int pFeatureLevel,
            out IntPtr ppImmediateContext
        );

        // COM delegates matching verified vtable indices
        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int QueryInterfaceDelegate(IntPtr thisPtr, ref Guid riid, out IntPtr ppvObject);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate uint ReleaseDelegate(IntPtr thisPtr);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int EnumAdapters1Delegate(IntPtr thisPtr, uint adapter, out IntPtr ppAdapter);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int EnumOutputsDelegate(IntPtr thisPtr, uint output, out IntPtr ppOutput);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int GetDesc1Delegate(IntPtr thisPtr, out DXGI_ADAPTER_DESC1 pDesc);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int DuplicateOutputDelegate(IntPtr thisPtr, IntPtr pDevice, out IntPtr ppOutputDuplication);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int AcquireNextFrameDelegate(IntPtr thisPtr, uint timeoutInMilliseconds, out DXGI_OUTDUPL_FRAME_INFO pFrameInfo, out IntPtr ppDesktopResource);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int ReleaseFrameDelegate(IntPtr thisPtr);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int CreateTexture2DDelegate(IntPtr thisPtr, ref D3D11_TEXTURE2D_DESC pDesc, IntPtr pInitialData, out IntPtr ppTexture2D);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate void GetTextureDescDelegate(IntPtr thisPtr, out D3D11_TEXTURE2D_DESC pDesc);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int MapDelegate(IntPtr thisPtr, IntPtr pResource, uint subresource, uint mapType, uint mapFlags, out D3D11_MAPPED_SUBRESOURCE pMappedResource);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate void UnmapDelegate(IntPtr thisPtr, IntPtr pResource, uint subresource);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate void CopyResourceDelegate(IntPtr thisPtr, IntPtr pDstResource, IntPtr pSrcResource);

        private static T GetVtblMethod<T>(IntPtr comPtr, int vtableIndex) where T : class
        {
            IntPtr vtbl = Marshal.ReadIntPtr(comPtr);
            IntPtr fnPtr = Marshal.ReadIntPtr(vtbl, vtableIndex * IntPtr.Size);
            return Marshal.GetDelegateForFunctionPointer(fnPtr, typeof(T)) as T;
        }

        private static void SafeRelease(ref IntPtr comPtr)
        {
            if (comPtr != IntPtr.Zero)
            {
                try
                {
                    ReleaseDelegate rel = GetVtblMethod<ReleaseDelegate>(comPtr, 2);
                    rel(comPtr);
                }
                catch { }
                comPtr = IntPtr.Zero;
            }
        }

        private static int ComQueryInterface(IntPtr comPtr, Guid iid, out IntPtr result)
        {
            result = IntPtr.Zero;
            if (comPtr == IntPtr.Zero) return unchecked((int)0x80004003);
            QueryInterfaceDelegate qi = GetVtblMethod<QueryInterfaceDelegate>(comPtr, 0);
            Guid g = iid;
            return qi(comPtr, ref g, out result);
        }

        private sealed class DxgiDuplicator : IDisposable
        {
            public string AdapterName;
            public int SrcWidth;
            public int SrcHeight;
            public uint TextureFormat;

            private IntPtr _device = IntPtr.Zero;
            private IntPtr _context = IntPtr.Zero;
            private IntPtr _duplication = IntPtr.Zero;
            private IntPtr _stagingTex = IntPtr.Zero;

            private CopyResourceDelegate _fnCopyResource;
            private MapDelegate _fnMap;
            private UnmapDelegate _fnUnmap;
            private AcquireNextFrameDelegate _fnAcquire;
            private ReleaseFrameDelegate _fnRelease;
            private CreateTexture2DDelegate _fnCreateTex2D;
            private bool _frameAcquired = false;

            public static bool TryCreate(out DxgiDuplicator dup, out string diagReason)
            {
                dup = null;
                diagReason = "Unknown DXGI init error";
                IntPtr factory = IntPtr.Zero;
                Guid iidFactory = IID_IDXGIFactory1;
                int hr = CreateDXGIFactory1(ref iidFactory, out factory);
                if (hr < 0 || factory == IntPtr.Zero)
                {
                    diagReason = string.Format("CreateDXGIFactory1 hr=0x{0:X8}", hr);
                    return false;
                }

                try
                {
                    EnumAdapters1Delegate enumAdapters = GetVtblMethod<EnumAdapters1Delegate>(factory, 12);
                    int[] featureLevels = new int[] { 0xB100, 0xB000, 0xA100, 0xA000 };
                    List<string> failures = new List<string>();

                    for (uint aIdx = 0; aIdx < 12; aIdx++)
                    {
                        IntPtr adapter = IntPtr.Zero;
                        int hrAd = enumAdapters(factory, aIdx, out adapter);
                        if (hrAd == DXGI_ERROR_NOT_FOUND || hrAd < 0 || adapter == IntPtr.Zero)
                        {
                            break;
                        }

                        string adapterDesc = "Adapter #" + aIdx;
                        try
                        {
                            DXGI_ADAPTER_DESC1 desc;
                            GetDesc1Delegate getDesc = GetVtblMethod<GetDesc1Delegate>(adapter, 10);
                            if (getDesc(adapter, out desc) >= 0 && !string.IsNullOrEmpty(desc.Description))
                            {
                                adapterDesc = desc.Description.Trim();
                            }

                            EnumOutputsDelegate enumOutputs = GetVtblMethod<EnumOutputsDelegate>(adapter, 7);
                            for (uint oIdx = 0; oIdx < 4; oIdx++)
                            {
                                IntPtr output = IntPtr.Zero;
                                int hrOut = enumOutputs(adapter, oIdx, out output);
                                if (hrOut == DXGI_ERROR_NOT_FOUND || hrOut < 0 || output == IntPtr.Zero)
                                {
                                    if (oIdx == 0) failures.Add(adapterDesc + ": no output");
                                    break;
                                }

                                try
                                {
                                    IntPtr output1 = IntPtr.Zero;
                                    int hrQ = ComQueryInterface(output, IID_IDXGIOutput1, out output1);
                                    if (hrQ < 0 || output1 == IntPtr.Zero)
                                    {
                                        failures.Add(string.Format("{0}[{1}]: QI IDXGIOutput1 hr=0x{2:X8}", adapterDesc, oIdx, hrQ));
                                        continue;
                                    }

                                    try
                                    {
                                        IntPtr device = IntPtr.Zero;
                                        IntPtr context = IntPtr.Zero;
                                        int outFl = 0;
                                        // D3D_DRIVER_TYPE_UNKNOWN = 0 when explicit pAdapter is passed
                                        int hrDev = D3D11CreateDevice(
                                            adapter,
                                            0,
                                            IntPtr.Zero,
                                            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                                            featureLevels,
                                            (uint)featureLevels.Length,
                                            D3D11_SDK_VERSION,
                                            out device,
                                            out outFl,
                                            out context
                                        );
                                        if (hrDev < 0 || device == IntPtr.Zero || context == IntPtr.Zero)
                                        {
                                            SafeRelease(ref device);
                                            SafeRelease(ref context);
                                            failures.Add(string.Format("{0}[{1}]: D3D11CreateDevice hr=0x{2:X8}", adapterDesc, oIdx, hrDev));
                                            continue;
                                        }

                                        DuplicateOutputDelegate dupOut = GetVtblMethod<DuplicateOutputDelegate>(output1, 22);
                                        IntPtr duplication = IntPtr.Zero;
                                        int hrDup = dupOut(output1, device, out duplication);
                                        if (hrDup < 0 || duplication == IntPtr.Zero)
                                        {
                                            SafeRelease(ref duplication);
                                            SafeRelease(ref context);
                                            SafeRelease(ref device);
                                            failures.Add(string.Format("{0}[{1}]: DuplicateOutput hr=0x{2:X8}", adapterDesc, oIdx, hrDup));
                                            continue;
                                        }

                                        dup = new DxgiDuplicator();
                                        dup.AdapterName = adapterDesc;
                                        dup._device = device;
                                        dup._context = context;
                                        dup._duplication = duplication;
                                        dup._fnCreateTex2D = GetVtblMethod<CreateTexture2DDelegate>(device, 5);
                                        dup._fnCopyResource = GetVtblMethod<CopyResourceDelegate>(context, 47);
                                        dup._fnMap = GetVtblMethod<MapDelegate>(context, 14);
                                        dup._fnUnmap = GetVtblMethod<UnmapDelegate>(context, 15);
                                        dup._fnAcquire = GetVtblMethod<AcquireNextFrameDelegate>(duplication, 8);
                                        dup._fnRelease = GetVtblMethod<ReleaseFrameDelegate>(duplication, 14);
                                        diagReason = "OK";
                                        return true;
                                    }
                                    finally
                                    {
                                        SafeRelease(ref output1);
                                    }
                                }
                                finally
                                {
                                    SafeRelease(ref output);
                                }
                            }
                        }
                        finally
                        {
                            SafeRelease(ref adapter);
                        }
                    }

                    diagReason = failures.Count > 0 ? string.Join("; ", failures.ToArray()) : "No DXGI output found";
                    return false;
                }
                finally
                {
                    SafeRelease(ref factory);
                }
            }

            private bool EnsureStagingTexture(uint w, uint h, uint fmt)
            {
                if (_stagingTex != IntPtr.Zero && SrcWidth == (int)w && SrcHeight == (int)h && TextureFormat == fmt)
                {
                    return true;
                }
                SafeRelease(ref _stagingTex);
                D3D11_TEXTURE2D_DESC desc = new D3D11_TEXTURE2D_DESC();
                desc.Width = w;
                desc.Height = h;
                desc.MipLevels = 1;
                desc.ArraySize = 1;
                desc.Format = fmt;
                desc.SampleCount = 1;
                desc.SampleQuality = 0;
                desc.Usage = D3D11_USAGE_STAGING;
                desc.BindFlags = 0;
                desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
                desc.MiscFlags = 0;

                IntPtr stg = IntPtr.Zero;
                int hr = _fnCreateTex2D(_device, ref desc, IntPtr.Zero, out stg);
                if (hr < 0 || stg == IntPtr.Zero)
                {
                    SafeRelease(ref stg);
                    return false;
                }
                _stagingTex = stg;
                SrcWidth = (int)w;
                SrcHeight = (int)h;
                TextureFormat = fmt;
                return true;
            }

            // Return codes:
            // 1 = new desktop pixels written into cleanBuf
            // 2 = mouse-only update (cleanBuf still valid)
            // 0 = DXGI_ERROR_WAIT_TIMEOUT
            // -1 = fatal/access lost (recreate or GDI fallback)
            public unsafe int AcquireNextIntoCleanBuffer(
                uint timeoutMs,
                int dstW,
                int dstH,
                int dstStride,
                bool hasCleanBuf,
                byte[] cleanBuf,
                ref int[] xMap,
                ref int[] yMap,
                ref int mapSrcW,
                ref int mapSrcH,
                ref int mapDstW,
                ref int mapDstH,
                out DXGI_OUTDUPL_FRAME_INFO info,
                out string errDetail
            )
            {
                info = new DXGI_OUTDUPL_FRAME_INFO();
                errDetail = null;
                IntPtr desktopResource = IntPtr.Zero;
                int hr = _fnAcquire(_duplication, timeoutMs, out info, out desktopResource);
                if (hr == DXGI_ERROR_WAIT_TIMEOUT)
                {
                    return 0;
                }
                if (hr < 0)
                {
                    errDetail = string.Format("AcquireNextFrame hr=0x{0:X8}", hr);
                    return -1;
                }

                _frameAcquired = true;
                try
                {
                    if (info.LastPresentTime == 0)
                    {
                        return hasCleanBuf ? 2 : 0;
                    }

                    if (desktopResource == IntPtr.Zero)
                    {
                        return hasCleanBuf ? 2 : 0;
                    }

                    IntPtr tex2D = IntPtr.Zero;
                    int hrQ = ComQueryInterface(desktopResource, IID_ID3D11Texture2D, out tex2D);
                    if (hrQ < 0 || tex2D == IntPtr.Zero)
                    {
                        errDetail = string.Format("QI ID3D11Texture2D hr=0x{0:X8}", hrQ);
                        return -1;
                    }

                    try
                    {
                        D3D11_TEXTURE2D_DESC srcDesc;
                        GetTextureDescDelegate getTexDesc = GetVtblMethod<GetTextureDescDelegate>(tex2D, 10);
                        getTexDesc(tex2D, out srcDesc);

                        if (srcDesc.Width == 0 || srcDesc.Height == 0)
                        {
                            errDetail = "Zero-size desktop texture";
                            return -1;
                        }

                        if (srcDesc.Format != DXGI_FORMAT_B8G8R8A8_UNORM &&
                            srcDesc.Format != DXGI_FORMAT_B8G8R8X8_UNORM &&
                            srcDesc.Format != DXGI_FORMAT_R8G8B8A8_UNORM)
                        {
                            errDetail = "Unsupported DXGI format=" + srcDesc.Format;
                            return -1;
                        }

                        if (!EnsureStagingTexture(srcDesc.Width, srcDesc.Height, srcDesc.Format))
                        {
                            errDetail = "CreateTexture2D staging failed";
                            return -1;
                        }

                        _fnCopyResource(_context, _stagingTex, tex2D);

                        D3D11_MAPPED_SUBRESOURCE mapped;
                        int hrMap = _fnMap(_context, _stagingTex, 0, D3D11_MAP_READ, 0, out mapped);
                        if (hrMap < 0 || mapped.pData == IntPtr.Zero)
                        {
                            errDetail = string.Format("Map staging failed hr=0x{0:X8}", hrMap);
                            return -1;
                        }

                        try
                        {
                            int sW = (int)srcDesc.Width;
                            int sH = (int)srcDesc.Height;
                            if (xMap == null || yMap == null || mapSrcW != sW || mapSrcH != sH || mapDstW != dstW || mapDstH != dstH)
                            {
                                BuildScaleMaps(sW, sH, dstW, dstH, out xMap, out yMap);
                                mapSrcW = sW;
                                mapSrcH = sH;
                                mapDstW = dstW;
                                mapDstH = dstH;
                            }

                            bool swapRB = (srcDesc.Format == DXGI_FORMAT_R8G8B8A8_UNORM);
                            DownscaleBgraToBgr24Parallel(
                                (byte*)mapped.pData.ToPointer(),
                                (int)mapped.RowPitch,
                                sW,
                                sH,
                                cleanBuf,
                                dstStride,
                                dstW,
                                dstH,
                                xMap,
                                yMap,
                                swapRB
                            );
                        }
                        finally
                        {
                            _fnUnmap(_context, _stagingTex, 0);
                        }

                        return 1;
                    }
                    finally
                    {
                        SafeRelease(ref tex2D);
                    }
                }
                finally
                {
                    SafeRelease(ref desktopResource);
                    if (_frameAcquired)
                    {
                        _fnRelease(_duplication);
                        _frameAcquired = false;
                    }
                }
            }

            public void Dispose()
            {
                if (_frameAcquired && _duplication != IntPtr.Zero && _fnRelease != null)
                {
                    try { _fnRelease(_duplication); } catch { }
                    _frameAcquired = false;
                }
                SafeRelease(ref _stagingTex);
                SafeRelease(ref _duplication);
                SafeRelease(ref _context);
                SafeRelease(ref _device);
            }
        }

        private static void BuildScaleMaps(int srcW, int srcH, int dstW, int dstH, out int[] xMap, out int[] yMap)
        {
            xMap = new int[dstW];
            for (int x = 0; x < dstW; x++)
            {
                int sx = (int)(((long)x * srcW) / dstW);
                if (sx >= srcW) sx = srcW - 1;
                xMap[x] = sx * 4;
            }
            yMap = new int[dstH];
            for (int y = 0; y < dstH; y++)
            {
                int sy = (int)(((long)y * srcH) / dstH);
                if (sy >= srcH) sy = srcH - 1;
                yMap[y] = sy;
            }
        }

        private static unsafe void DownscaleBgraToBgr24Parallel(
            byte* srcPtr,
            int srcPitch,
            int srcW,
            int srcH,
            byte[] dstCleanBuf,
            int dstStride,
            int dstW,
            int dstH,
            int[] xMap,
            int[] yMap,
            bool swapRB
        )
        {
            IntPtr srcIntPtr = new IntPtr(srcPtr);
            const int bands = 4;

            if (srcW == dstW && srcH == dstH && !swapRB)
            {
                Parallel.For(0, bands, band =>
                {
                    byte* sBase = (byte*)srcIntPtr.ToPointer();
                    int yStart = (band * dstH) / bands;
                    int yEnd = ((band + 1) * dstH) / bands;
                    fixed (byte* dBase = dstCleanBuf)
                    {
                        for (int y = yStart; y < yEnd; y++)
                        {
                            byte* sp = sBase + (long)y * srcPitch;
                            byte* dp = dBase + (long)y * dstStride;
                            byte* spEnd = sp + (srcW * 4);
                            while (sp < spEnd)
                            {
                                dp[0] = sp[0];
                                dp[1] = sp[1];
                                dp[2] = sp[2];
                                sp += 4;
                                dp += 3;
                            }
                        }
                    }
                });
                return;
            }

            Parallel.For(0, bands, band =>
            {
                byte* sBase = (byte*)srcIntPtr.ToPointer();
                int yStart = (band * dstH) / bands;
                int yEnd = ((band + 1) * dstH) / bands;
                fixed (byte* dBase = dstCleanBuf)
                fixed (int* xm = xMap)
                {
                    if (!swapRB)
                    {
                        for (int y = yStart; y < yEnd; y++)
                        {
                            byte* srcRow = sBase + (long)yMap[y] * srcPitch;
                            byte* dp = dBase + (long)y * dstStride;
                            int x = 0;
                            int limit = dstW - 3;
                            for (; x < limit; x += 4)
                            {
                                byte* sp0 = srcRow + xm[x];
                                byte* sp1 = srcRow + xm[x + 1];
                                byte* sp2 = srcRow + xm[x + 2];
                                byte* sp3 = srcRow + xm[x + 3];
                                dp[0] = sp0[0]; dp[1] = sp0[1]; dp[2] = sp0[2];
                                dp[3] = sp1[0]; dp[4] = sp1[1]; dp[5] = sp1[2];
                                dp[6] = sp2[0]; dp[7] = sp2[1]; dp[8] = sp2[2];
                                dp[9] = sp3[0]; dp[10] = sp3[1]; dp[11] = sp3[2];
                                dp += 12;
                            }
                            for (; x < dstW; x++)
                            {
                                byte* sp = srcRow + xm[x];
                                dp[0] = sp[0];
                                dp[1] = sp[1];
                                dp[2] = sp[2];
                                dp += 3;
                            }
                        }
                    }
                    else
                    {
                        for (int y = yStart; y < yEnd; y++)
                        {
                            byte* srcRow = sBase + (long)yMap[y] * srcPitch;
                            byte* dp = dBase + (long)y * dstStride;
                            for (int x = 0; x < dstW; x++)
                            {
                                byte* sp = srcRow + xm[x];
                                dp[0] = sp[2];
                                dp[1] = sp[1];
                                dp[2] = sp[0];
                                dp += 3;
                            }
                        }
                    }
                }
            });
        }

        private static unsafe int ProbeDxgi()
        {
            Console.WriteLine("SwiftDropCapture DXGI Self-Test Probe");
            IntPtr factory = IntPtr.Zero;
            Guid iidF = IID_IDXGIFactory1;
            int hr = CreateDXGIFactory1(ref iidF, out factory);
            Console.WriteLine(string.Format("CreateDXGIFactory1 hr=0x{0:X8} ptr=0x{1:X}", hr, factory.ToInt64()));
            if (hr < 0 || factory == IntPtr.Zero) return 1;

            IntPtr targetAdapter = IntPtr.Zero;
            string targetAdapterName = "None";
            IntPtr targetOutput1 = IntPtr.Zero;

            try
            {
                EnumAdapters1Delegate enumAdapters = GetVtblMethod<EnumAdapters1Delegate>(factory, 12);
                for (uint i = 0; i < 12; i++)
                {
                    IntPtr ad = IntPtr.Zero;
                    if (enumAdapters(factory, i, out ad) < 0 || ad == IntPtr.Zero) break;
                    DXGI_ADAPTER_DESC1 desc;
                    GetVtblMethod<GetDesc1Delegate>(ad, 10)(ad, out desc);
                    string name = (desc.Description ?? ("Adapter " + i)).Trim();
                    IntPtr out0 = IntPtr.Zero;
                    int hrOut = GetVtblMethod<EnumOutputsDelegate>(ad, 7)(ad, 0, out out0);
                    Console.WriteLine(string.Format("Adapter[{0}]=\"{1}\" VRAM={2}MB EnumOutputs(0)=0x{3:X8}", i, name, (long)desc.DedicatedVideoMemory.ToUInt64() / (1024 * 1024), hrOut));

                    if (hrOut >= 0 && out0 != IntPtr.Zero && targetAdapter == IntPtr.Zero)
                    {
                        IntPtr o1 = IntPtr.Zero;
                        int hrQ = ComQueryInterface(out0, IID_IDXGIOutput1, out o1);
                        if (hrQ >= 0 && o1 != IntPtr.Zero)
                        {
                            targetAdapter = ad;
                            targetAdapterName = name;
                            targetOutput1 = o1;
                            SafeRelease(ref out0);
                            continue;
                        }
                    }
                    SafeRelease(ref out0);
                    if (targetAdapter == IntPtr.Zero && i == 0)
                    {
                        // Keep a fallback copy only if needed later; don't overwrite above
                    }
                    SafeRelease(ref ad);
                }

                // If headless session returned no EnumOutputs(0), still pick adapter 0 to test D3D11 + CreateTexture2D + Map + CopyResource + Downscale!
                bool usingFallbackAdapter0 = false;
                if (targetAdapter == IntPtr.Zero)
                {
                    usingFallbackAdapter0 = true;
                    enumAdapters(factory, 0, out targetAdapter);
                    if (targetAdapter != IntPtr.Zero)
                    {
                        DXGI_ADAPTER_DESC1 desc;
                        GetVtblMethod<GetDesc1Delegate>(targetAdapter, 10)(targetAdapter, out desc);
                        targetAdapterName = (desc.Description ?? "Adapter 0").Trim();
                    }
                }

                if (targetAdapter == IntPtr.Zero)
                {
                    Console.WriteLine("ERROR: No DXGI adapter available.");
                    return 2;
                }

                IntPtr device = IntPtr.Zero;
                IntPtr context = IntPtr.Zero;
                int outFl = 0;
                int[] fls = new int[] { 0xB100, 0xB000, 0xA100, 0xA000 };
                int hrDev = D3D11CreateDevice(targetAdapter, 0, IntPtr.Zero, D3D11_CREATE_DEVICE_BGRA_SUPPORT, fls, (uint)fls.Length, D3D11_SDK_VERSION, out device, out outFl, out context);
                Console.WriteLine(string.Format("D3D11CreateDevice adapter=\"{0}\" fallback={1} hr=0x{2:X8} featureLevel=0x{3:X}", targetAdapterName, usingFallbackAdapter0, hrDev, outFl));
                if (hrDev < 0 || device == IntPtr.Zero || context == IntPtr.Zero)
                {
                    SafeRelease(ref context);
                    SafeRelease(ref device);
                    return 3;
                }

                IntPtr texDef = IntPtr.Zero;
                IntPtr texStg = IntPtr.Zero;
                try
                {
                    CreateTexture2DDelegate createTex = GetVtblMethod<CreateTexture2DDelegate>(device, 5);

                    D3D11_TEXTURE2D_DESC dDef = new D3D11_TEXTURE2D_DESC();
                    dDef.Width = 2560; dDef.Height = 1440; dDef.MipLevels = 1; dDef.ArraySize = 1;
                    dDef.Format = DXGI_FORMAT_B8G8R8A8_UNORM; dDef.SampleCount = 1; dDef.Usage = D3D11_USAGE_DEFAULT;
                    int hrT1 = createTex(device, ref dDef, IntPtr.Zero, out texDef);

                    D3D11_TEXTURE2D_DESC dStg = new D3D11_TEXTURE2D_DESC();
                    dStg.Width = 2560; dStg.Height = 1440; dStg.MipLevels = 1; dStg.ArraySize = 1;
                    dStg.Format = DXGI_FORMAT_B8G8R8A8_UNORM; dStg.SampleCount = 1; dStg.Usage = D3D11_USAGE_STAGING;
                    dStg.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
                    int hrT2 = createTex(device, ref dStg, IntPtr.Zero, out texStg);

                    Console.WriteLine(string.Format("CreateTexture2D DEFAULT hr=0x{0:X8}, STAGING hr=0x{1:X8}", hrT1, hrT2));
                    if (hrT1 < 0 || hrT2 < 0 || texDef == IntPtr.Zero || texStg == IntPtr.Zero) return 4;

                    D3D11_TEXTURE2D_DESC gotDesc;
                    GetVtblMethod<GetTextureDescDelegate>(texDef, 10)(texDef, out gotDesc);
                    Console.WriteLine(string.Format("Texture2D GetDesc {0}x{1} fmt={2} OK", gotDesc.Width, gotDesc.Height, gotDesc.Format));
                    if (gotDesc.Width != 2560 || gotDesc.Height != 1440 || gotDesc.Format != DXGI_FORMAT_B8G8R8A8_UNORM) return 5;

                    CopyResourceDelegate copyRes = GetVtblMethod<CopyResourceDelegate>(context, 47);
                    MapDelegate mapFn = GetVtblMethod<MapDelegate>(context, 14);
                    UnmapDelegate unmapFn = GetVtblMethod<UnmapDelegate>(context, 15);

                    int dstW = 1600, dstH = 900;
                    int dstStride = ((dstW * 3 + 3) & ~3);
                    byte[] cleanBuf = new byte[dstStride * dstH];
                    int[] xMap, yMap;
                    BuildScaleMaps(2560, 1440, dstW, dstH, out xMap, out yMap);

                    // Warmup 1 iteration
                    copyRes(context, texStg, texDef);
                    D3D11_MAPPED_SUBRESOURCE mapped;
                    int hrM = mapFn(context, texStg, 0, D3D11_MAP_READ, 0, out mapped);
                    Console.WriteLine(string.Format("CopyResource+Map hr=0x{0:X8} pitch={1}", hrM, mapped.RowPitch));
                    if (hrM < 0 || mapped.pData == IntPtr.Zero) return 6;
                    DownscaleBgraToBgr24Parallel((byte*)mapped.pData.ToPointer(), (int)mapped.RowPitch, 2560, 1440, cleanBuf, dstStride, dstW, dstH, xMap, yMap, false);
                    unmapFn(context, texStg, 0);

                    const int iters = 10;
                    Stopwatch sw = Stopwatch.StartNew();
                    for (int k = 0; k < iters; k++)
                    {
                        copyRes(context, texStg, texDef);
                        mapFn(context, texStg, 0, D3D11_MAP_READ, 0, out mapped);
                        DownscaleBgraToBgr24Parallel((byte*)mapped.pData.ToPointer(), (int)mapped.RowPitch, 2560, 1440, cleanBuf, dstStride, dstW, dstH, xMap, yMap, false);
                        unmapFn(context, texStg, 0);
                    }
                    sw.Stop();
                    double avgMs = sw.Elapsed.TotalMilliseconds / iters;
                    Console.WriteLine(string.Format("CopyResource+Map+Unmap OK; Downscale 2560x1440->1600x900 avg={0:F2}ms ({1} iters)", avgMs, iters));

                    if (targetOutput1 != IntPtr.Zero)
                    {
                        IntPtr dupPtr = IntPtr.Zero;
                        int hrDup = GetVtblMethod<DuplicateOutputDelegate>(targetOutput1, 22)(targetOutput1, device, out dupPtr);
                        Console.WriteLine(string.Format("DuplicateOutput hr=0x{0:X8}", hrDup));
                        SafeRelease(ref dupPtr);
                    }
                    else
                    {
                        Console.WriteLine("DuplicateOutput skipped (headless session: no active monitor output attached)");
                    }

                    return 0;
                }
                finally
                {
                    SafeRelease(ref texStg);
                    SafeRelease(ref texDef);
                    SafeRelease(ref context);
                    SafeRelease(ref device);
                }
            }
            finally
            {
                SafeRelease(ref targetOutput1);
                SafeRelease(ref targetAdapter);
                SafeRelease(ref factory);
            }
        }

        private sealed class RingSlot
        {
            public int Index;
            public IntPtr hDC;
            public IntPtr hDib;
            public IntPtr Bits;
            public int Stride;
            public Bitmap Bmp;
            public int State; // 0=Idle, 1=Capturing, 2=Ready, 3=Encoding
            public long Seq;
            public int Width;
            public int Height;
            public byte CursorVis;
            public ushort CursorXNorm;
            public ushort CursorYNorm;
            public byte EngineFlag;
        }

        private static volatile int _targetW = 1600;
        private static volatile int _targetH = 900;
        private static volatile int _targetFps = 60;
        private static volatile int _jpegQuality = 54;
        private static volatile int _motionQuality = 44;
        private static volatile bool _running = true;

        private static readonly object _ringLock = new object();
        private static readonly object _deltaLock = new object();
        private static readonly object _outLock = new object();
        private static RingSlot[] _slots = new RingSlot[SLOT_COUNT];
        private static long _captureSeq = 0;
        private static long _lastWrittenSeq = 0;
        private static byte[] _prevPixels = null;
        private static int _prevPixW = 0;
        private static int _prevPixH = 0;
        private static byte[] _cachedStaticJpeg = null;
        private static int _cachedPixW = 0;
        private static int _cachedPixH = 0;
        private static byte _cachedCursorVis = 0;
        private static bool _needsRestFrame = false;
        private static long _lastEmitTickMs = 0;
        private static ushort _prevCursorX = 0;
        private static ushort _prevCursorY = 0;
        private static Stopwatch _clock = Stopwatch.StartNew();
        private static Stream _outStream;
        private static ImageCodecInfo _jpegCodec;

        private static void EnableBestDpiAwareness()
        {
            try
            {
                // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4
                SetProcessDpiAwarenessContext(new IntPtr(-4));
                return;
            }
            catch { }
            try { SetProcessDPIAware(); } catch { }
        }

        private static ImageCodecInfo GetJpegEncoder()
        {
            foreach (ImageCodecInfo codec in ImageCodecInfo.GetImageEncoders())
            {
                if (codec.FormatID == ImageFormat.Jpeg.Guid) return codec;
            }
            return null;
        }

        private static void AllocateSlots(int dstW, int dstH)
        {
            DisposeSlots();
            int stride = ((dstW * 3 + 3) & ~3);
            for (int i = 0; i < SLOT_COUNT; i++)
            {
                BITMAPINFO bmi = new BITMAPINFO();
                bmi.bmiHeader.biSize = (uint)Marshal.SizeOf(typeof(BITMAPINFOHEADER));
                bmi.bmiHeader.biWidth = dstW;
                bmi.bmiHeader.biHeight = -dstH; // Top-down DIB
                bmi.bmiHeader.biPlanes = 1;
                bmi.bmiHeader.biBitCount = 24;

                IntPtr bits;
                IntPtr hDC = CreateCompatibleDC(IntPtr.Zero);
                IntPtr hDib = CreateDIBSection(hDC, ref bmi, 0, out bits, IntPtr.Zero, 0);
                SelectObject(hDC, hDib);
                SetStretchBltMode(hDC, COLORONCOLOR);

                RingSlot slot = new RingSlot();
                slot.Index = i;
                slot.hDC = hDC;
                slot.hDib = hDib;
                slot.Bits = bits;
                slot.Stride = stride;
                slot.Bmp = new Bitmap(dstW, dstH, stride, PixelFormat.Format24bppRgb, bits);
                slot.Width = dstW;
                slot.Height = dstH;
                slot.State = 0;
                slot.Seq = 0;
                slot.EngineFlag = 0;
                _slots[i] = slot;
            }
        }

        private static void DisposeSlots()
        {
            for (int i = 0; i < SLOT_COUNT; i++)
            {
                RingSlot s = _slots[i];
                if (s != null)
                {
                    if (s.Bmp != null) { try { s.Bmp.Dispose(); } catch { } }
                    if (s.hDib != IntPtr.Zero) { try { DeleteObject(s.hDib); } catch { } }
                    if (s.hDC != IntPtr.Zero) { try { DeleteDC(s.hDC); } catch { } }
                    _slots[i] = null;
                }
            }
        }

        private static void PollCursorCoords(int srcW, int srcH, out byte curVis, out ushort cxNorm, out ushort cyNorm, out IntPtr hCur, out int rawX, out int rawY)
        {
            curVis = 0;
            cxNorm = 0;
            cyNorm = 0;
            hCur = IntPtr.Zero;
            rawX = 0;
            rawY = 0;
            try
            {
                CURSORINFO ci = new CURSORINFO();
                ci.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
                if (!GetCursorInfo(ref ci) || (ci.flags & CURSOR_SHOWING) == 0) return;

                rawX = ci.ptScreenPos.x;
                rawY = ci.ptScreenPos.y;
                if (rawX < 0 || rawY < 0 || rawX > srcW || rawY > srcH) return;

                curVis = 1;
                double nx = srcW > 1 ? Math.Max(0.0, Math.Min(1.0, (double)rawX / srcW)) : 0.0;
                double ny = srcH > 1 ? Math.Max(0.0, Math.Min(1.0, (double)rawY / srcH)) : 0.0;
                cxNorm = (ushort)Math.Round(nx * 65535.0);
                cyNorm = (ushort)Math.Round(ny * 65535.0);
                hCur = ci.hCursor;
            }
            catch { }
        }

        private static void DrawScaledCursor(IntPtr targetHdc, int srcW, int srcH, int dstW, int dstH, out byte curVis, out ushort cxNorm, out ushort cyNorm)
        {
            IntPtr hCur;
            int rawX, rawY;
            PollCursorCoords(srcW, srcH, out curVis, out cxNorm, out cyNorm, out hCur, out rawX, out rawY);
            if (curVis == 0 || hCur == IntPtr.Zero) return;

            try
            {
                int x = rawX;
                int y = rawY;
                IntPtr hIcon = CopyIcon(hCur);
                if (hIcon == IntPtr.Zero) return;
                try
                {
                    ICONINFO ii;
                    if (GetIconInfo(hIcon, out ii))
                    {
                        try
                        {
                            x -= ii.xHotspot;
                            y -= ii.yHotspot;
                        }
                        finally
                        {
                            if (ii.hbmMask != IntPtr.Zero) DeleteObject(ii.hbmMask);
                            if (ii.hbmColor != IntPtr.Zero) DeleteObject(ii.hbmColor);
                        }
                    }
                    double sx = (double)dstW / srcW;
                    double sy = (double)dstH / srcH;
                    int dx = (int)Math.Round(x * sx);
                    int dy = (int)Math.Round(y * sy);
                    int cw = Math.Max(14, (int)Math.Round(32 * sx));
                    int ch = Math.Max(14, (int)Math.Round(32 * sy));
                    DrawIconEx(targetHdc, dx, dy, hIcon, cw, ch, 0, IntPtr.Zero, 0x0003);
                }
                finally
                {
                    DestroyIcon(hIcon);
                }
            }
            catch { }
        }

        private static void FillTrailer(byte[] trailer, byte flags, byte curVis, ushort cxNorm, ushort cyNorm)
        {
            trailer[0] = flags;
            trailer[1] = curVis;
            trailer[2] = (byte)(cxNorm & 0xFF);
            trailer[3] = (byte)((cxNorm >> 8) & 0xFF);
            trailer[4] = (byte)(cyNorm & 0xFF);
            trailer[5] = (byte)((cyNorm >> 8) & 0xFF);
            trailer[6] = (byte)'S';
            trailer[7] = (byte)'D';
        }

        private static unsafe void CopyIntoSlotFromBitmap(RingSlot slot, Bitmap srcBmp)
        {
            BitmapData bd = srcBmp.LockBits(new Rectangle(0, 0, srcBmp.Width, srcBmp.Height), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
            try
            {
                int rows = Math.Min(slot.Height, bd.Height);
                int copyBytes = Math.Min(slot.Stride, Math.Abs(bd.Stride));
                int copyQwords = copyBytes >> 3;
                int tailBytes = copyBytes & 7;
                byte* dstBase = (byte*)slot.Bits.ToPointer();
                byte* srcBase = (byte*)bd.Scan0.ToPointer();
                for (int y = 0; y < rows; y++)
                {
                    ulong* sp = (ulong*)(srcBase + (long)y * bd.Stride);
                    ulong* dp = (ulong*)(dstBase + (long)y * slot.Stride);
                    for (int q = 0; q < copyQwords; q++) dp[q] = sp[q];
                    byte* sb = (byte*)(sp + copyQwords);
                    byte* db = (byte*)(dp + copyQwords);
                    for (int b = 0; b < tailBytes; b++) db[b] = sb[b];
                }
            }
            finally
            {
                srcBmp.UnlockBits(bd);
            }
        }

        private static Bitmap _cachedStatusBmp = null;
        private static int _cachedStatusW = 0;
        private static int _cachedStatusH = 0;

        private static void DrawStatusFallback(RingSlot slot, int w, int h, string reason)
        {
            if (_cachedStatusBmp == null || _cachedStatusW != w || _cachedStatusH != h)
            {
                if (_cachedStatusBmp != null) { try { _cachedStatusBmp.Dispose(); } catch { } }
                _cachedStatusBmp = new Bitmap(w, h, PixelFormat.Format24bppRgb);
                using (Graphics g = Graphics.FromImage(_cachedStatusBmp))
                {
                    g.Clear(Color.FromArgb(8, 9, 11));
                    using (Brush accent = new SolidBrush(Color.FromArgb(42, 125, 163, 192)))
                    {
                        g.FillEllipse(accent, w / 2 - 120, h / 2 - 120, 240, 240);
                    }
                    using (Font titleFont = new Font("Segoe UI", 20, FontStyle.Bold))
                    using (Font subFont = new Font("Segoe UI", 11, FontStyle.Regular))
                    using (Brush whiteBrush = new SolidBrush(Color.FromArgb(244, 245, 247)))
                    using (Brush mutedBrush = new SolidBrush(Color.FromArgb(136, 141, 150)))
                    using (StringFormat fmt = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center })
                    {
                        g.DrawString("SwiftDrop 60Hz — Dang cho quyen Desktop Windows", titleFont, whiteBrush, new RectangleF(32, h / 2 - 44, w - 64, 40), fmt);
                        g.DrawString(reason, subFont, mutedBrush, new RectangleF(32, h / 2 + 4, w - 64, 36), fmt);
                    }
                }
                _cachedStatusW = w;
                _cachedStatusH = h;
            }
            CopyIntoSlotFromBitmap(slot, _cachedStatusBmp);
        }

        private static bool WriteFrameWithTrailer(long capSeq, byte[] jpegBuf, int jpegLen, byte[] trailer)
        {
            int totalLen = jpegLen + 8;
            lock (_outLock)
            {
                if (!_running || capSeq <= _lastWrittenSeq)
                {
                    return false;
                }
                _lastWrittenSeq = capSeq;
                byte[] lenHdr = new byte[4];
                lenHdr[0] = (byte)(totalLen & 0xFF);
                lenHdr[1] = (byte)((totalLen >> 8) & 0xFF);
                lenHdr[2] = (byte)((totalLen >> 16) & 0xFF);
                lenHdr[3] = (byte)((totalLen >> 24) & 0xFF);
                _outStream.Write(lenHdr, 0, 4);
                _outStream.Write(jpegBuf, 0, jpegLen);
                _outStream.Write(trailer, 0, 8);
                _outStream.Flush();
                return true;
            }
        }

        private static unsafe void PrepareFullFrameAction(
            RingSlot picked,
            out bool shouldEmit,
            out byte[] cachedJpeg,
            out byte flags,
            out int encQuality,
            out bool cacheResult
        )
        {
            shouldEmit = false;
            cachedJpeg = null;
            byte baseFlag = FLAG_KEYFRAME;
            int baseQ = _jpegQuality;
            encQuality = baseQ;
            cacheResult = false;
            flags = picked.EngineFlag;

            int w = picked.Width;
            int h = picked.Height;
            int stride = picked.Stride;
            int totalBytes = stride * h;

            lock (_deltaLock)
            {
                long nowMs = _clock.ElapsedMilliseconds;
                bool forceReset = (_prevPixels == null || _prevPixels.Length != totalBytes || _prevPixW != w || _prevPixH != h);

                if (forceReset)
                {
                    _prevPixels = new byte[totalBytes];
                    Marshal.Copy(picked.Bits, _prevPixels, 0, totalBytes);
                    _prevPixW = w;
                    _prevPixH = h;
                    _cachedStaticJpeg = null;
                    _cachedPixW = 0;
                    _cachedPixH = 0;
                    _cachedCursorVis = picked.CursorVis;
                    _needsRestFrame = false;
                    _lastEmitTickMs = nowMs;
                    _prevCursorX = picked.CursorXNorm;
                    _prevCursorY = picked.CursorYNorm;
                    shouldEmit = true;
                    flags = (byte)(FLAG_KEYFRAME | picked.EngineFlag);
                    encQuality = Math.Min(84, baseQ + 8);
                    cacheResult = true;
                    return;
                }

                // Direct unsafe comparison on picked.Bits vs _prevPixels (12x12 grid, zero intermediate copy)
                int changed = 0;
                int samples = 0;
                byte* curPtr = (byte*)picked.Bits.ToPointer();
                fixed (byte* prevPtr = _prevPixels)
                {
                    for (int y = 0; y < h; y += 12)
                    {
                        int rowOff = y * stride;
                        for (int x = 0; x < w; x += 12)
                        {
                            samples++;
                            int idx = rowOff + x * 3;
                            int dr = curPtr[idx] - prevPtr[idx]; if (dr < 0) dr = -dr;
                            int dg = curPtr[idx + 1] - prevPtr[idx + 1]; if (dg < 0) dg = -dg;
                            int db = curPtr[idx + 2] - prevPtr[idx + 2]; if (db < 0) db = -db;
                            if (dr + dg + db > 24)
                            {
                                changed++;
                            }
                        }
                    }
                }

                bool cursorMoved = (picked.CursorVis != _cachedCursorVis) ||
                    (picked.CursorVis != 0 && (Math.Abs((int)picked.CursorXNorm - (int)_prevCursorX) > 20 || Math.Abs((int)picked.CursorYNorm - (int)_prevCursorY) > 20));
                _prevCursorX = picked.CursorXNorm;
                _prevCursorY = picked.CursorYNorm;
                _cachedCursorVis = picked.CursorVis;

                if (changed == 0 && !cursorMoved)
                {
                    if (_needsRestFrame)
                    {
                        Marshal.Copy(picked.Bits, _prevPixels, 0, totalBytes);
                        _needsRestFrame = false;
                        _lastEmitTickMs = nowMs;
                        shouldEmit = true;
                        flags = (byte)(FLAG_REST_HD | picked.EngineFlag);
                        encQuality = Math.Min(84, Math.Max(baseQ + 14, 78));
                        cacheResult = true;
                        return;
                    }
                    if (_cachedStaticJpeg != null && _cachedPixW == w && _cachedPixH == h)
                    {
                        if ((nowMs - _lastEmitTickMs) < 18)
                        {
                            shouldEmit = false;
                            return;
                        }
                        _lastEmitTickMs = nowMs;
                        shouldEmit = true;
                        cachedJpeg = _cachedStaticJpeg;
                        flags = (byte)(FLAG_REST_HD | picked.EngineFlag);
                        return;
                    }
                    Marshal.Copy(picked.Bits, _prevPixels, 0, totalBytes);
                    _lastEmitTickMs = nowMs;
                    shouldEmit = true;
                    flags = (byte)(FLAG_REST_HD | picked.EngineFlag);
                    encQuality = Math.Min(84, baseQ + 12);
                    cacheResult = true;
                    return;
                }

                Marshal.Copy(picked.Bits, _prevPixels, 0, totalBytes);
                _cachedStaticJpeg = null;
                _needsRestFrame = true;
                _lastEmitTickMs = nowMs;
                shouldEmit = true;

                int changedPct = (changed * 100) / Math.Max(1, samples);
                if (changedPct >= 12)
                {
                    baseFlag = FLAG_MOTION;
                    encQuality = Math.Max(36, Math.Min(_motionQuality, baseQ - 10));
                }
                else
                {
                    baseFlag = FLAG_KEYFRAME;
                    encQuality = baseQ;
                }
                flags = (byte)(baseFlag | picked.EngineFlag);
            }
        }

        private static void WorkerLoop()
        {
            MemoryStream ms = new MemoryStream(256 * 1024);
            EncoderParameters ep = null;
            int lastQ = -1;
            byte[] trailer = new byte[8];

            try
            {
                while (_running)
                {
                    RingSlot picked = null;
                    long pickedSeq = 0;

                    lock (_ringLock)
                    {
                        while (_running)
                        {
                            int bestIdx = -1;
                            long bestSeq = -1;
                            for (int i = 0; i < SLOT_COUNT; i++)
                            {
                                if (_slots[i] != null && _slots[i].State == 2 && _slots[i].Seq > bestSeq)
                                {
                                    bestSeq = _slots[i].Seq;
                                    bestIdx = i;
                                }
                            }
                            if (bestIdx >= 0)
                            {
                                picked = _slots[bestIdx];
                                picked.State = 3; // Encoding
                                pickedSeq = bestSeq;
                                break;
                            }
                            Monitor.Wait(_ringLock, 40);
                        }
                    }

                    if (!_running || picked == null) break;

                    try
                    {
                        bool shouldEmit, cacheResult;
                        byte[] cachedJpeg;
                        byte flags;
                        int encQ;
                        PrepareFullFrameAction(picked, out shouldEmit, out cachedJpeg, out flags, out encQ, out cacheResult);
                        if (!shouldEmit)
                        {
                            continue;
                        }

                        FillTrailer(trailer, flags, picked.CursorVis, picked.CursorXNorm, picked.CursorYNorm);

                        if (cachedJpeg != null)
                        {
                            WriteFrameWithTrailer(pickedSeq, cachedJpeg, cachedJpeg.Length, trailer);
                            continue;
                        }

                        if (ep == null || encQ != lastQ)
                        {
                            if (ep != null) ep.Dispose();
                            ep = new EncoderParameters(1);
                            ep.Param[0] = new EncoderParameter(Encoder.Quality, (long)encQ);
                            lastQ = encQ;
                        }

                        ms.SetLength(0);
                        picked.Bmp.Save(ms, _jpegCodec, ep);
                        int jpegLen = (int)ms.Length;

                        if ((flags & 0x7F) == FLAG_MOTION)
                        {
                            if (jpegLen > 48000 && _motionQuality > 36) _motionQuality = Math.Max(36, _motionQuality - 4);
                            else if (jpegLen < 28000 && _motionQuality < _jpegQuality - 10) _motionQuality = Math.Min(_jpegQuality - 10, _motionQuality + 2);
                        }

                        if (cacheResult)
                        {
                            byte[] snap = new byte[jpegLen];
                            Buffer.BlockCopy(ms.GetBuffer(), 0, snap, 0, jpegLen);
                            lock (_deltaLock)
                            {
                                if (_prevPixW == picked.Width && _prevPixH == picked.Height)
                                {
                                    _cachedStaticJpeg = snap;
                                    _cachedPixW = picked.Width;
                                    _cachedPixH = picked.Height;
                                }
                            }
                        }

                        WriteFrameWithTrailer(pickedSeq, ms.GetBuffer(), jpegLen, trailer);
                    }
                    catch { }
                    finally
                    {
                        lock (_ringLock)
                        {
                            if (picked != null && picked.State == 3)
                            {
                                picked.State = 0; // Idle
                                Monitor.PulseAll(_ringLock);
                            }
                        }
                    }
                }
            }
            finally
            {
                if (ep != null) ep.Dispose();
                ms.Dispose();
            }
        }

        private static void StartStdinConfigWatcher()
        {
            Thread t = new Thread(() =>
            {
                try
                {
                    string line;
                    while ((line = Console.In.ReadLine()) != null)
                    {
                        if (line == "QUIT")
                        {
                            _running = false;
                            lock (_ringLock) { Monitor.PulseAll(_ringLock); }
                            break;
                        }
                        if (line.StartsWith("CFG|"))
                        {
                            string[] parts = line.Split('|');
                            if (parts.Length >= 5)
                            {
                                int nw, nh, nfps, nq;
                                if (int.TryParse(parts[1], out nw) && nw >= 320 && nw <= 3840) _targetW = nw;
                                if (int.TryParse(parts[2], out nh) && nh >= 240 && nh <= 2160) _targetH = nh;
                                if (int.TryParse(parts[3], out nfps) && nfps >= 5 && nfps <= 60) _targetFps = nfps;
                                if (int.TryParse(parts[4], out nq) && nq >= 36 && nq <= 95) _jpegQuality = nq;
                            }
                        }
                    }
                }
                catch { }
                _running = false;
                lock (_ringLock) { Monitor.PulseAll(_ringLock); }
            });
            t.IsBackground = true;
            t.Start();
        }

        private static bool CaptureViaGdi(RingSlot slot, int srcW, int srcH, int dstW, int dstH, out byte curVis, out ushort cxNorm, out ushort cyNorm, ref bool loggedUnavailable)
        {
            curVis = 0;
            cxNorm = 0;
            cyNorm = 0;
            IntPtr hScreenDC = GetDC(IntPtr.Zero);
            if (hScreenDC == IntPtr.Zero)
            {
                if (!loggedUnavailable)
                {
                    Console.Error.WriteLine("DESKTOP_HANDLE_WAITING:GetDC returned null");
                    loggedUnavailable = true;
                }
                return false;
            }
            try
            {
                bool bltOk = (dstW == srcW && dstH == srcH)
                    ? BitBlt(slot.hDC, 0, 0, dstW, dstH, hScreenDC, 0, 0, SRCCOPY)
                    : StretchBlt(slot.hDC, 0, 0, dstW, dstH, hScreenDC, 0, 0, srcW, srcH, SRCCOPY);
                if (bltOk)
                {
                    DrawScaledCursor(slot.hDC, srcW, srcH, dstW, dstH, out curVis, out cxNorm, out cyNorm);
                    GdiFlush();
                    loggedUnavailable = false;
                    return true;
                }
                int err = Marshal.GetLastWin32Error();
                if (!loggedUnavailable)
                {
                    Console.Error.WriteLine("DESKTOP_HANDLE_WAITING:BitBlt/StretchBlt failed code=" + err);
                    loggedUnavailable = true;
                }
                return false;
            }
            finally
            {
                ReleaseDC(IntPtr.Zero, hScreenDC);
            }
        }

        private static RingSlot AcquireCaptureSlot()
        {
            RingSlot slot = null;
            lock (_ringLock)
            {
                while (_running && slot == null)
                {
                    for (int i = 0; i < SLOT_COUNT; i++)
                    {
                        if (_slots[i] != null && _slots[i].State == 0) { slot = _slots[i]; break; }
                    }
                    if (slot == null)
                    {
                        long minSeq = long.MaxValue;
                        for (int i = 0; i < SLOT_COUNT; i++)
                        {
                            if (_slots[i] != null && _slots[i].State == 2 && _slots[i].Seq < minSeq)
                            {
                                minSeq = _slots[i].Seq;
                                slot = _slots[i];
                            }
                        }
                    }
                    if (slot != null)
                    {
                        slot.State = 1; // Capturing
                        break;
                    }
                    Monitor.Wait(_ringLock, 5);
                }
            }
            return slot;
        }

        private static void ReleaseCaptureSlotUnused(RingSlot slot)
        {
            if (slot == null) return;
            lock (_ringLock)
            {
                if (slot.State == 1)
                {
                    slot.State = 0;
                    Monitor.PulseAll(_ringLock);
                }
            }
        }

        private static int RunStream(int initW, int initH, int initFps, int initQuality, bool singleShot)
        {
            bool timerSet = false;
            try { timerSet = (timeBeginPeriod(1) == 0); } catch { }

            _targetW = Math.Max(320, Math.Min(3840, initW));
            _targetH = Math.Max(240, Math.Min(2160, initH));
            _targetFps = Math.Max(5, Math.Min(60, initFps));
            _jpegQuality = Math.Max(36, Math.Min(95, initQuality));
            _motionQuality = Math.Max(36, _jpegQuality - 16);

            _jpegCodec = GetJpegEncoder();
            if (_jpegCodec == null)
            {
                if (timerSet) { try { timeEndPeriod(1); } catch { } }
                return 1;
            }
            _outStream = Console.OpenStandardOutput();

            if (!singleShot)
            {
                StartStdinConfigWatcher();
            }

            Thread[] workers = null;
            if (!singleShot)
            {
                workers = new Thread[WORKER_COUNT];
                for (int i = 0; i < WORKER_COUNT; i++)
                {
                    workers[i] = new Thread(WorkerLoop);
                    workers[i].IsBackground = true;
                    workers[i].Priority = ThreadPriority.AboveNormal;
                    workers[i].Start();
                }
            }

            DxgiDuplicator dxgi = null;
            DxgiDuplicator pendingDxgi = null;
            int dxgiInitActive = 0;
            bool hadDxgiEver = false;
            long dxgiRetryDelayMs = 4000;
            long lastDxgiAttemptMs = -20000;
            bool loggedGdiEngine = false;
            bool loggedUnavailable = false;
            object dxgiHandoffLock = new object();

            byte[] cleanBuf = null;
            int cleanW = 0, cleanH = 0, cleanStride = 0;
            bool hasCleanBuf = false;
            int[] xMap = null, yMap = null;
            int mapSrcW = 0, mapSrcH = 0, mapDstW = 0, mapDstH = 0;

            Stopwatch sw = new Stopwatch();
            int curSlotW = 0, curSlotH = 0;
            byte[] staticTrailer = new byte[8];

            try
            {
                while (_running)
                {
                    sw.Restart();

                    if (dxgi == null)
                    {
                        DxgiDuplicator readyDup = null;
                        lock (dxgiHandoffLock)
                        {
                            if (pendingDxgi != null)
                            {
                                readyDup = pendingDxgi;
                                pendingDxgi = null;
                            }
                        }
                        if (readyDup != null)
                        {
                            dxgi = readyDup;
                            hadDxgiEver = true;
                            dxgiRetryDelayMs = 1500;
                            hasCleanBuf = false;
                            Console.Error.WriteLine("CAPTURE_ENGINE=DXGI (" + dxgi.AdapterName + ")");
                        }
                        else if (!singleShot && Thread.VolatileRead(ref dxgiInitActive) == 0)
                        {
                            long nowMs = _clock.ElapsedMilliseconds;
                            if ((nowMs - lastDxgiAttemptMs) >= dxgiRetryDelayMs)
                            {
                                Thread.VolatileWrite(ref dxgiInitActive, 1);
                                Thread initThread = new Thread(() =>
                                {
                                    try
                                    {
                                        string diagReason;
                                        DxgiDuplicator newDup;
                                        if (DxgiDuplicator.TryCreate(out newDup, out diagReason))
                                        {
                                            if (_running)
                                            {
                                                lock (dxgiHandoffLock)
                                                {
                                                    if (pendingDxgi != null) { try { pendingDxgi.Dispose(); } catch { } }
                                                    pendingDxgi = newDup;
                                                }
                                            }
                                            else
                                            {
                                                try { newDup.Dispose(); } catch { }
                                            }
                                        }
                                        else
                                        {
                                            dxgiRetryDelayMs = hadDxgiEver ? 2000 : Math.Min(15000, dxgiRetryDelayMs * 2);
                                            if (!loggedGdiEngine)
                                            {
                                                Console.Error.WriteLine("CAPTURE_ENGINE=GDI (" + diagReason + ")");
                                                loggedGdiEngine = true;
                                            }
                                        }
                                    }
                                    catch { }
                                    finally
                                    {
                                        lastDxgiAttemptMs = _clock.ElapsedMilliseconds;
                                        Thread.VolatileWrite(ref dxgiInitActive, 0);
                                    }
                                });
                                initThread.IsBackground = true;
                                initThread.Start();
                            }
                        }
                    }

                    int rawW = GetSystemMetrics(SM_CXSCREEN);
                    int rawH = GetSystemMetrics(SM_CYSCREEN);
                    int srcW = rawW > 0 ? rawW : 1920;
                    int srcH = rawH > 0 ? rawH : 1080;

                    int reqW = _targetW;
                    int reqH = _targetH;
                    double scale = Math.Min(1.0, Math.Min((double)reqW / srcW, (double)reqH / srcH));
                    int dstW = Math.Max(320, ((int)Math.Round(srcW * scale)) & ~1);
                    int dstH = Math.Max(240, ((int)Math.Round(srcH * scale)) & ~1);
                    int dstStride = ((dstW * 3 + 3) & ~3);
                    int totalBytes = dstStride * dstH;

                    if (_slots[0] == null || dstW != curSlotW || dstH != curSlotH)
                    {
                        lock (_ringLock)
                        {
                            while (_running)
                            {
                                bool anyEncoding = false;
                                for (int i = 0; i < SLOT_COUNT; i++)
                                {
                                    if (_slots[i] != null && _slots[i].State == 3) { anyEncoding = true; break; }
                                }
                                if (!anyEncoding) break;
                                Monitor.Wait(_ringLock, 10);
                            }
                            if (!_running) break;
                            AllocateSlots(dstW, dstH);
                            curSlotW = dstW;
                            curSlotH = dstH;
                        }
                    }

                    if (cleanBuf == null || cleanW != dstW || cleanH != dstH)
                    {
                        cleanBuf = new byte[totalBytes];
                        cleanW = dstW;
                        cleanH = dstH;
                        cleanStride = dstStride;
                        hasCleanBuf = false;
                    }

                    // 1. Try DXGI Desktop Duplication first (~2ms in VRAM/System staging!)
                    bool emittedStaticFast = false;
                    bool captured = false;
                    byte engineFlag = 0;
                    byte curVis = 0;
                    ushort cxNorm = 0, cyNorm = 0;

                    RingSlot slot = AcquireCaptureSlot();
                    if (!_running || slot == null) break;

                    if (dxgi != null)
                    {
                        DXGI_OUTDUPL_FRAME_INFO dInfo;
                        string errDetail;
                        uint acqTimeout = hasCleanBuf ? 16u : 120u;
                        int resCode = dxgi.AcquireNextIntoCleanBuffer(
                            acqTimeout,
                            dstW,
                            dstH,
                            dstStride,
                            hasCleanBuf,
                            cleanBuf,
                            ref xMap,
                            ref yMap,
                            ref mapSrcW,
                            ref mapSrcH,
                            ref mapDstW,
                            ref mapDstH,
                            out dInfo,
                            out errDetail
                        );

                        if (resCode == -1)
                        {
                            Console.Error.WriteLine("CAPTURE_ENGINE=GDI (" + (errDetail ?? "DXGI frame error") + ")");
                            dxgi.Dispose();
                            dxgi = null;
                            hasCleanBuf = false;
                            lastDxgiAttemptMs = _clock.ElapsedMilliseconds;
                        }
                        else if (resCode == 0 && hasCleanBuf && !singleShot)
                        {
                            // Desktop image did not change during AcquireNextFrame(16ms).
                            // Check if cursor changed; if static & cached JPEG exists, re-emit cached frame at 0.01ms!
                            IntPtr hCurDummy;
                            int rX, rY;
                            PollCursorCoords(srcW, srcH, out curVis, out cxNorm, out cyNorm, out hCurDummy, out rX, out rY);

                            bool fastStaticSent = false;
                            byte[] fastSnap = null;
                            lock (_deltaLock)
                            {
                                bool curUnchanged = (curVis == _cachedCursorVis) &&
                                    (curVis == 0 || (Math.Abs((int)cxNorm - (int)_prevCursorX) <= 20 && Math.Abs((int)cyNorm - (int)_prevCursorY) <= 20));
                                if (curUnchanged && !_needsRestFrame && _cachedStaticJpeg != null && _cachedPixW == dstW && _cachedPixH == dstH)
                                {
                                    long tNow = _clock.ElapsedMilliseconds;
                                    if ((tNow - _lastEmitTickMs) >= 18)
                                    {
                                        _lastEmitTickMs = tNow;
                                        fastSnap = _cachedStaticJpeg;
                                    }
                                    fastStaticSent = true;
                                }
                            }

                            if (fastStaticSent)
                            {
                                ReleaseCaptureSlotUnused(slot);
                                if (fastSnap != null)
                                {
                                    long sSeq = Interlocked.Increment(ref _captureSeq);
                                    FillTrailer(staticTrailer, (byte)(FLAG_REST_HD | FLAG_DXGI), curVis, cxNorm, cyNorm);
                                    WriteFrameWithTrailer(sSeq, fastSnap, fastSnap.Length, staticTrailer);
                                }
                                emittedStaticFast = true;
                            }
                            else
                            {
                                // Cursor moved over static desktop: zero-GPU-copy reuse of cleanBuf + draw new cursor!
                                Marshal.Copy(cleanBuf, 0, slot.Bits, totalBytes);
                                int curSrcW = dxgi.SrcWidth > 0 ? dxgi.SrcWidth : srcW;
                                int curSrcH = dxgi.SrcHeight > 0 ? dxgi.SrcHeight : srcH;
                                DrawScaledCursor(slot.hDC, curSrcW, curSrcH, dstW, dstH, out curVis, out cxNorm, out cyNorm);
                                GdiFlush();
                                captured = true;
                                engineFlag = FLAG_DXGI;
                            }
                        }
                        else if (resCode == 1 || resCode == 2)
                        {
                            if (resCode == 1) hasCleanBuf = true;
                            Marshal.Copy(cleanBuf, 0, slot.Bits, totalBytes);
                            int curSrcW = dxgi.SrcWidth > 0 ? dxgi.SrcWidth : srcW;
                            int curSrcH = dxgi.SrcHeight > 0 ? dxgi.SrcHeight : srcH;
                            DrawScaledCursor(slot.hDC, curSrcW, curSrcH, dstW, dstH, out curVis, out cxNorm, out cyNorm);
                            GdiFlush();
                            captured = true;
                            engineFlag = FLAG_DXGI;
                        }
                    }

                    if (emittedStaticFast)
                    {
                        int budget = Math.Max(8, (int)Math.Round(1000.0 / _targetFps));
                        int sl = budget - (int)sw.ElapsedMilliseconds;
                        if (sl > 1) Thread.Sleep(sl);
                        continue;
                    }

                    // 2. GDI StretchBlt bootstrap / fallback if DXGI unavailable or waiting first present
                    if (!captured)
                    {
                        captured = CaptureViaGdi(slot, srcW, srcH, dstW, dstH, out curVis, out cxNorm, out cyNorm, ref loggedUnavailable);
                        engineFlag = 0;
                    }

                    slot.CursorVis = curVis;
                    slot.CursorXNorm = cxNorm;
                    slot.CursorYNorm = cyNorm;
                    slot.EngineFlag = engineFlag;

                    if (!captured)
                    {
                        DrawStatusFallback(slot, dstW, dstH, "Windows dang khoa / cho quyen UAC hoac phien an");
                    }

                    long seq = Interlocked.Increment(ref _captureSeq);

                    if (singleShot)
                    {
                        byte[] trailer = new byte[8];
                        FillTrailer(trailer, (byte)(FLAG_KEYFRAME | engineFlag), curVis, cxNorm, cyNorm);
                        using (MemoryStream ms = new MemoryStream(256 * 1024))
                        using (EncoderParameters ep = new EncoderParameters(1))
                        {
                            ep.Param[0] = new EncoderParameter(Encoder.Quality, (long)_jpegQuality);
                            slot.Bmp.Save(ms, _jpegCodec, ep);
                            WriteFrameWithTrailer(seq, ms.GetBuffer(), (int)ms.Length, trailer);
                        }
                        ReleaseCaptureSlotUnused(slot);
                        break;
                    }

                    lock (_ringLock)
                    {
                        for (int i = 0; i < SLOT_COUNT; i++)
                        {
                            if (_slots[i] != null && _slots[i] != slot && _slots[i].State == 2)
                            {
                                _slots[i].State = 0;
                            }
                        }
                        slot.Seq = seq;
                        slot.State = 2; // Ready
                        Monitor.Pulse(_ringLock);
                    }

                    if (!captured)
                    {
                        Thread.Sleep(18);
                        continue;
                    }

                    int frameBudgetMs = Math.Max(8, (int)Math.Round(1000.0 / _targetFps));
                    int elapsedMs = (int)sw.ElapsedMilliseconds;
                    int sleepMs = frameBudgetMs - elapsedMs;
                    if (sleepMs > 1)
                    {
                        Thread.Sleep(sleepMs);
                    }
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("STREAMER_EXIT:" + ex.Message);
            }
            finally
            {
                _running = false;
                lock (_ringLock) { Monitor.PulseAll(_ringLock); }
                lock (_outLock) { Monitor.PulseAll(_outLock); }
                if (workers != null)
                {
                    for (int i = 0; i < workers.Length; i++)
                    {
                        try { workers[i].Join(200); } catch { }
                    }
                }
                if (dxgi != null) { try { dxgi.Dispose(); } catch { } }
                lock (dxgiHandoffLock)
                {
                    if (pendingDxgi != null) { try { pendingDxgi.Dispose(); pendingDxgi = null; } catch { } }
                }
                if (_cachedStatusBmp != null) { try { _cachedStatusBmp.Dispose(); _cachedStatusBmp = null; } catch { } }
                DisposeSlots();
                if (timerSet) { try { timeEndPeriod(1); } catch { } }
            }

            return 0;
        }

        private static int Main(string[] args)
        {
            EnableBestDpiAwareness();

            int width = 1600, height = 900, fps = 60, quality = 54;
            bool once = false, probeDxgi = false;

            for (int i = 0; i < args.Length; i++)
            {
                string a = args[i];
                if (string.Equals(a, "--probe-dxgi", StringComparison.OrdinalIgnoreCase)) probeDxgi = true;
                else if (string.Equals(a, "--once", StringComparison.OrdinalIgnoreCase)) once = true;
                else if (string.Equals(a, "--width", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length) int.TryParse(args[++i], out width);
                else if (string.Equals(a, "--height", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length) int.TryParse(args[++i], out height);
                else if (string.Equals(a, "--fps", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length) int.TryParse(args[++i], out fps);
                else if (string.Equals(a, "--quality", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length) int.TryParse(args[++i], out quality);
            }

            if (probeDxgi)
            {
                return ProbeDxgi();
            }

            return RunStream(width, height, fps, quality, once);
        }
    }
}
