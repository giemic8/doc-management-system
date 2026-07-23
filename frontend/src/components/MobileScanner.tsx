import React, { useRef, useState, useEffect } from 'react';
import { Camera, X, Check, RefreshCw, Upload, Sparkles } from 'lucide-react';
import { uploadDocument } from '../services/api';

interface MobileScannerProps {
  onClose: () => void;
  onUploadSuccess: () => void;
}

export const MobileScanner: React.FC<MobileScannerProps> = ({ onClose, onUploadSuccess }) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [cameraActive, setCameraActive] = useState(false);

  useEffect(() => {
    startCamera();
    return () => stopCamera();
  }, []);

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        setCameraActive(true);
      }
    } catch (err) {
      console.warn('Camera access error (simulating image upload):', err);
    }
  };

  const stopCamera = () => {
    if (videoRef.current && videoRef.current.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach((track) => track.stop());
    }
  };

  const capturePhoto = () => {
    if (videoRef.current && canvasRef.current) {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      canvas.width = video.videoWidth || 1280;
      canvas.height = video.videoHeight || 720;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
        setCapturedImage(dataUrl);
      }
    }
  };

  const handleUploadCaptured = async () => {
    if (!capturedImage) return;
    setUploading(true);
    try {
      // Convert DataURL to File blob
      const res = await fetch(capturedImage);
      const blob = await res.blob();
      const file = new File([blob], `scan_${Date.now()}.jpg`, { type: 'image/jpeg' });

      await uploadDocument(file);
      onUploadSuccess();
      onClose();
    } catch (err) {
      console.error(err);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950 flex flex-col justify-between p-4 sm:p-6 animate-fade-in">
      {/* Top Header */}
      <div className="flex items-center justify-between text-white z-10">
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-purple-400" />
          <span className="font-bold text-base">Smart Camera Document Scanner</span>
        </div>
        <button onClick={onClose} className="p-2 rounded-full bg-slate-900 text-slate-300">
          <X className="w-6 h-6" />
        </button>
      </div>

      {/* Main Viewfinder / Canvas */}
      <div className="flex-1 my-4 relative rounded-2xl overflow-hidden bg-slate-900 border border-slate-800 flex items-center justify-center">
        {!capturedImage ? (
          <>
            <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
            <canvas ref={canvasRef} className="hidden" />

            {/* Smart Document Alignment Overlay */}
            <div className="absolute inset-8 border-2 border-dashed border-indigo-400/70 rounded-2xl pointer-events-none flex items-center justify-center">
              <span className="text-xs font-semibold px-3 py-1 rounded-full bg-indigo-950/80 text-indigo-300 border border-indigo-500/40 backdrop-blur-md">
                Dokument im Rahmen ausrichten
              </span>
            </div>
          </>
        ) : (
          <img src={capturedImage} alt="Scan preview" className="w-full h-full object-contain" />
        )}
      </div>

      {/* Footer Capture Controls */}
      <div className="flex items-center justify-center gap-6 py-2">
        {!capturedImage ? (
          <button
            onClick={capturePhoto}
            className="w-16 h-16 rounded-full bg-gradient-to-tr from-indigo-500 via-purple-500 to-pink-500 p-1 shadow-xl shadow-indigo-500/30 transition-transform active:scale-95 flex items-center justify-center"
          >
            <div className="w-full h-full rounded-full bg-white flex items-center justify-center">
              <Camera className="w-7 h-7 text-indigo-600" />
            </div>
          </button>
        ) : (
          <div className="flex items-center gap-4">
            <button
              onClick={() => setCapturedImage(null)}
              className="btn-secondary py-3 px-5 text-sm"
            >
              <RefreshCw className="w-4 h-4" />
              <span>Neu aufnehmen</span>
            </button>

            <button
              onClick={handleUploadCaptured}
              disabled={uploading}
              className="btn-primary py-3 px-6 text-sm"
            >
              <Upload className="w-4 h-4" />
              <span>{uploading ? 'Wird hochgeladen...' : 'Scan Hochladen'}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
