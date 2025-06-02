"use client"

import React, { useEffect, useRef, useState } from "react"
import { useParams, useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { ArrowLeft, Phone, Mic, MicOff, Volume2, Video, VideoOff, Monitor, MonitorOff, RotateCcw, RotateCw, FlipHorizontal } from "lucide-react"
import { NotificationBell } from "@/components/notification-bell"

// Extend Window interface for webkit AudioContext
declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext
  }
}

const SIGNALING_SERVER_URL = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:3001"
const ICE_CONFIG = { 
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" }
  ],
  iceCandidatePoolSize: 10,
  bundlePolicy: 'max-bundle' as RTCBundlePolicy,
  rtcpMuxPolicy: 'require' as RTCRtcpMuxPolicy
}

export default function CallPage() {
  const params = useParams()
  const router = useRouter()
  const rawRoomId = params.roomId as string
  const roomId = decodeURIComponent(rawRoomId)
  const [currentUser, setCurrentUser] = useState("")
  const [actualIsListener, setActualIsListener] = useState(false) // Track actual operational mode
  const [joined, setJoined] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  const [error, setError] = useState("")
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({})
  const [remoteVideoStreams, setRemoteVideoStreams] = useState<Record<string, MediaStream>>({})
  const [remoteScreenStreams, setRemoteScreenStreams] = useState<Record<string, MediaStream>>({})
  const [participants, setParticipants] = useState<Set<string>>(new Set()) // Track all participants
  const localAudioRef = useRef<HTMLAudioElement>(null)
  const localVideoRef = useRef<HTMLVideoElement>(null)
  const localScreenRef = useRef<HTMLVideoElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const localVideoStreamRef = useRef<MediaStream | null>(null)
  const localScreenStreamRef = useRef<MediaStream | null>(null)
  const peerConnections = useRef<Record<string, RTCPeerConnection>>({})
  const [muted, setMuted] = useState(false)
  const [videoEnabled, setVideoEnabled] = useState(false)
  const [screenSharing, setScreenSharing] = useState(false)
  const [selectedParticipant, setSelectedParticipant] = useState<string | null>(null)
  const [peerMuted, setPeerMuted] = useState<Record<string, boolean>>({}) // <--- NEW: track muted state for each remote peer
  const [speakingPeers, setSpeakingPeers] = useState<Record<string, boolean>>({})
  const [localSpeaking, setLocalSpeaking] = useState(false)
  
  // Add state for camera switching
  const [currentCamera, setCurrentCamera] = useState<'user' | 'environment'>('user') // 'user' = front, 'environment' = back
  
  // Add state for camera mirror functionality
  const [isMirrored, setIsMirrored] = useState(true) // Default to mirrored for front camera

  const analyserRef = useRef<AnalyserNode | null>(null)
  const localAudioContextRef = useRef<AudioContext | null>(null)  // For each participant, create refs for audio, video, and screen
  const remoteAudioRefs = useRef<Record<string, React.RefObject<HTMLAudioElement | null>>>({})
  const remoteVideoRefs = useRef<Record<string, React.RefObject<HTMLVideoElement | null>>>({})
  const remoteScreenRefs = useRef<Record<string, React.RefObject<HTMLVideoElement | null>>>({})
  
  // Create refs for all participants (not just those with streams)
  Array.from(participants).forEach(peer => {
    if (!remoteAudioRefs.current[peer]) {
      remoteAudioRefs.current[peer] = React.createRef<HTMLAudioElement>()
    }
    if (!remoteVideoRefs.current[peer]) {
      remoteVideoRefs.current[peer] = React.createRef<HTMLVideoElement>()
    }
    if (!remoteScreenRefs.current[peer]) {
      remoteScreenRefs.current[peer] = React.createRef<HTMLVideoElement>()
    }
  })// Attach srcObject for local audio, video, and screen
  useEffect(() => {
    if (localAudioRef.current && localStreamRef.current) {
      localAudioRef.current.srcObject = localStreamRef.current
    }
    if (localVideoRef.current && localVideoStreamRef.current) {
      localVideoRef.current.srcObject = localVideoStreamRef.current
    }
    if (localScreenRef.current && localScreenStreamRef.current) {
      localScreenRef.current.srcObject = localScreenStreamRef.current
    }
  }, [localAudioRef, localVideoRef, localScreenRef, joined, actualIsListener, videoEnabled, screenSharing])
  // --- Ensure remote audio/video/screen elements are always "live" and properly set ---
  useEffect(() => {
    Object.entries(remoteStreams).forEach(([peer, stream]) => {
      const ref = remoteAudioRefs.current[peer]
      if (ref && ref.current && stream) {
        if (ref.current.srcObject !== stream) {
          ref.current.srcObject = stream
        }
        ref.current.controls = false
        ref.current.muted = !!peerMuted[peer] // <-- mute if user wants to mute this peer
        ref.current
          .play()
          .catch(() => {
            // Ignore play errors (autoplay policy)
          })
      }
    })
  }, [remoteStreams, peerMuted])
  // Attach video streams to video elements
  useEffect(() => {
    Object.entries(remoteVideoStreams).forEach(([peer, stream]) => {
      const ref = remoteVideoRefs.current[peer]
      if (ref && ref.current && stream) {
        console.log(`🎥 Attaching video stream for ${peer}:`, {
          streamId: stream.id,
          tracks: stream.getTracks().map(t => ({ 
            kind: t.kind, 
            label: t.label, 
            enabled: t.enabled,
            readyState: t.readyState,
            settings: t.getSettings ? t.getSettings() : 'N/A'
          })),
          videoTracks: stream.getVideoTracks().length,
          currentSrcObject: ref.current.srcObject ? 'assigned' : 'null'
        })
        
        if (ref.current.srcObject !== stream) {
          ref.current.srcObject = stream
          console.log(`✅ Video stream assigned to element for ${peer}`)
        }
        ref.current.controls = false
          // Enhanced video element setup with better dimension handling
        const videoElement = ref.current
        
        // Enhanced metadata event handler
        videoElement.onloadedmetadata = () => {
          const videoDimensions = {
            videoWidth: videoElement.videoWidth,
            videoHeight: videoElement.videoHeight,
            duration: videoElement.duration,
            readyState: videoElement.readyState,
            networkState: videoElement.networkState
          }
          console.log(`📹 Video metadata loaded for ${peer}:`, videoDimensions)
          
          // Enhanced dimension waiting with timeout protection
          if (videoElement.videoWidth === 0 || videoElement.videoHeight === 0) {
            console.log(`⏳ Waiting for video dimensions for ${peer} (this is normal for camera video)...`)
            
            let attempts = 0
            const maxAttempts = 50 // 5 seconds max wait
            
            const checkDimensions = () => {
              attempts++
              
              if (videoElement.videoWidth > 0 && videoElement.videoHeight > 0) {
                console.log(`✅ Video dimensions now available for ${peer} after ${attempts * 100}ms:`, {
                  videoWidth: videoElement.videoWidth,
                  videoHeight: videoElement.videoHeight,
                  attempts: attempts
                })
                return
              }
              
              if (attempts >= maxAttempts) {
                console.warn(`⚠️ Video dimensions still not available for ${peer} after ${attempts * 100}ms, but video may still work`)
                return
              }
              
              setTimeout(checkDimensions, 100)
            }
            
            setTimeout(checkDimensions, 100)
          } else {
            console.log(`✅ Video dimensions immediately available for ${peer}:`, {
              videoWidth: videoElement.videoWidth,
              videoHeight: videoElement.videoHeight
            })
          }
        }
          // Enhanced error handling
        videoElement.onerror = (e) => {
          console.error(`❌ Video error for ${peer}:`, e, {
            error: videoElement.error,
            networkState: videoElement.networkState,
            readyState: videoElement.readyState,
            currentSrc: videoElement.currentSrc
          })
        }
        
        // Enhanced can play event handler
        videoElement.oncanplay = () => {
          const canPlayInfo = {
            videoWidth: videoElement.videoWidth,
            videoHeight: videoElement.videoHeight,
            paused: videoElement.paused,
            currentTime: videoElement.currentTime,
            readyState: videoElement.readyState,
            networkState: videoElement.networkState
          }
          console.log(`▶️ Video can play for ${peer}:`, canPlayInfo)
          
          // Check if we now have dimensions
          if (videoElement.videoWidth > 0 && videoElement.videoHeight > 0) {
            console.log(`🎯 Video ready with dimensions ${videoElement.videoWidth}x${videoElement.videoHeight} for ${peer}`)
          } else {
            console.log(`⏳ Video can play but dimensions still pending for ${peer}`)
          }
        }
        
        // Add additional event listener for when video size changes
        videoElement.onresize = () => {
          console.log(`📐 Video resized for ${peer}:`, {
            videoWidth: videoElement.videoWidth,
            videoHeight: videoElement.videoHeight
          })
        }
        
        ref.current
          .play()
          .then(() => {
            console.log(`✅ Video playing for ${peer}`)
          })
          .catch((error) => {
            console.warn(`⚠️ Video autoplay failed for ${peer}:`, error)
          })
      }
    })
  }, [remoteVideoStreams])

  // Attach screen streams to screen elements
  useEffect(() => {
    Object.entries(remoteScreenStreams).forEach(([peer, stream]) => {
      const ref = remoteScreenRefs.current[peer]
      if (ref && ref.current && stream) {
        if (ref.current.srcObject !== stream) {
          ref.current.srcObject = stream
        }
        ref.current.controls = false
        ref.current
          .play()
          .catch(() => {
            // Ignore play errors (autoplay policy)
          })
      }
    })
  }, [remoteScreenStreams])// --- Local speaking detection ---
  useEffect(() => {
    if (!joined || actualIsListener || !localStreamRef.current) return
    let raf: number | undefined
    const AudioContextClass = window.AudioContext || window.webkitAudioContext
    if (!AudioContextClass) return
    const ctx = new AudioContextClass()
    localAudioContextRef.current = ctx
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    analyserRef.current = analyser
    const source = ctx.createMediaStreamSource(localStreamRef.current)
    source.connect(analyser)    
    const data = new Uint8Array(analyser.fftSize)
    function checkSpeaking() {
      if (!analyser) return
      analyser.getByteTimeDomainData(data)
      // Simple volume threshold - decreased threshold for more sensitive detection
      const rms = Math.sqrt(data.reduce((sum, v) => sum + Math.pow(v - 128, 2), 0) / data.length)
      setLocalSpeaking(rms > 4)
      raf = requestAnimationFrame(checkSpeaking)
    }
    checkSpeaking()
    return () => {
      if (raf !== undefined) cancelAnimationFrame(raf)
      analyser.disconnect()
      source.disconnect()
      ctx.close()
    }
  }, [joined, actualIsListener])  // --- Remote speaking detection ---
  useEffect(() => {
    // For each remote stream, create an analyser and update speakingPeers
    const peerIds = Object.keys(remoteStreams)
    const audioContexts: Record<string, AudioContext> = {}
    const analysers: Record<string, AnalyserNode> = {}
    const datas: Record<string, Uint8Array> = {}
    let raf: number | undefined
    let stopped = false

    function checkRemoteSpeaking() {
      if (stopped) return
      const newSpeaking: Record<string, boolean> = {}
      const AudioContextClass = window.AudioContext || window.webkitAudioContext
      if (!AudioContextClass) return
      
      peerIds.forEach(peer => {
        const stream = remoteStreams[peer]
        if (!stream) return
        if (!audioContexts[peer]) {
          audioContexts[peer] = new AudioContextClass()
          analysers[peer] = audioContexts[peer].createAnalyser()
          analysers[peer].fftSize = 512
          datas[peer] = new Uint8Array(analysers[peer].fftSize)
          const src = audioContexts[peer].createMediaStreamSource(stream)
          src.connect(analysers[peer])
        }        analysers[peer].getByteTimeDomainData(datas[peer])
        const rms = Math.sqrt(datas[peer].reduce((sum, v) => sum + Math.pow(v - 128, 2), 0) / datas[peer].length)
        newSpeaking[peer] = rms > 4
      })
      setSpeakingPeers(newSpeaking)
      raf = requestAnimationFrame(checkRemoteSpeaking)
    }
    if (peerIds.length > 0) {
      checkRemoteSpeaking()
    }
    return () => {
      stopped = true
      if (raf !== undefined) cancelAnimationFrame(raf)
      peerIds.forEach(peer => {
        if (audioContexts[peer]) audioContexts[peer].close()
      })
    }  }, [remoteStreams])  // Handle mute/unmute without stopping tracks to maintain WebRTC connections
  const handleMute = async () => {
    if (!muted) {
      // Muting - disable audio tracks without stopping them
      setMuted(true)
      if (localStreamRef.current) {
        localStreamRef.current.getAudioTracks().forEach(track => {
          track.enabled = false // Disable instead of stopping
          console.log('Audio track muted:', track.label, track.enabled)
        })
      }
    } else {
      // Unmuting
      if (localStreamRef.current) {
        // If we have a stream, just enable the tracks
        localStreamRef.current.getAudioTracks().forEach(track => {
          track.enabled = true
          console.log('Audio track unmuted:', track.label, track.enabled)
          if (track.label === "Arbitrary Audio Track") {
            alert("Microphone Error - Please press reconnect unmuted\nyou can not use the microphone until you reconnect.")
          }
        })
        setMuted(false)
        setError("")
      } else {
        // If no stream, request permission and create new stream
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
          localStreamRef.current = stream
          if (localAudioRef.current) {
            localAudioRef.current.srcObject = stream
          }
          
          // Ensure audio tracks are enabled
          stream.getAudioTracks().forEach(track => {
            track.enabled = true
            console.log('New audio track enabled:', track.label, track.enabled)
          })
          
          // Add audio tracks to all existing peer connections and trigger renegotiation
          for (const [remote, pc] of Object.entries(peerConnections.current)) {
            stream.getTracks().forEach(track => {
              if (!pc.getSenders().some(sender => sender.track === track)) {
                pc.addTrack(track, stream)
              }
            })
            
            // Always trigger renegotiation for both sides
            try {
              const offer = await pc.createOffer()
              await pc.setLocalDescription(offer)
              if (wsRef.current) {
                wsRef.current.send(JSON.stringify({ 
                  type: "call-offer", 
                  roomId, 
                  from: currentUser, 
                  to: remote, 
                  payload: pc.localDescription 
                }))
              }
            } catch (error) {
              console.error('Error creating unmute offer:', error)
            }
          }
          
          setMuted(false)
          setError("")
        } catch {
          setError("Microphone access denied. Please check browser permissions.")
        }
      }
    }
  }

  // Consistent join logic (same as chat)
  useEffect(() => {
    const username = sessionStorage.getItem(`username:${roomId}`) || ""
    if (!username) {
      router.replace(`/${encodeURIComponent(roomId)}`)
      return
    }
    setCurrentUser(username)
  }, [roomId, router])  // Perfect negotiation implementation to handle SSL transport role conflicts
  async function safeSetRemoteDescription(pc: RTCPeerConnection, desc: RTCSessionDescriptionInit, isPolite: boolean = false) {
    console.log(`Setting remote description: ${desc.type}, signaling state: ${pc.signalingState}, isPolite: ${isPolite}`)
    
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(desc));
      console.log(`Successfully set remote ${desc.type}`)
      return 'success'
    } catch (e: unknown) {
      const error = e as Error;
      console.error("setRemoteDescription error", error, desc, pc.signalingState);
      
      // Handle specific WebRTC errors
      if (error.name === 'InvalidStateError') {
        if (desc.type === 'offer') {
          if (pc.signalingState === 'have-local-offer' && !isPolite) {
            // Impolite peer ignores colliding offer
            console.log("Ignoring colliding offer (impolite peer)")
            return 'ignored'
          } else {
            // Polite peer handles collision with rollback
            console.log("Handling offer collision with rollback (polite peer)")
            try {
              await pc.setLocalDescription({ type: "rollback" })
              await pc.setRemoteDescription(new RTCSessionDescription(desc));
              console.log("Successfully recovered from offer collision")
              return 'success'
            } catch (rollbackError) {
              console.error("Rollback recovery failed:", rollbackError)
              return 'recreate'
            }
          }
        } else if (desc.type === 'answer') {
          if (pc.signalingState === 'stable') {
            // Answer in stable state - ignore it as it's likely stale
            console.log("Answer received in stable state, ignoring (likely stale)")
            return 'ignored'
          } else {
            console.log("Answer in wrong state, may need to recreate connection")
            return 'recreate'
          }
        }
      } else if (error.name === 'OperationError' || error.message.includes('SSL role')) {
        console.log("SSL transport error - recreating peer connection")
        return 'recreate'
      }
      
      // Re-throw other errors
      throw error
    }
  }

  const recreatePeerConnection = async (peerId: string) => {
    console.log(`Recreating peer connection for ${peerId}`)
    
    // Close existing connection
    if (peerConnections.current[peerId]) {
      peerConnections.current[peerId].close()
      delete peerConnections.current[peerId]
    }
    
    // Create new connection
    const newPc = createPeerConnection(peerId)
    
    // Trigger new negotiation
    try {
      const offer = await newPc.createOffer()
      await newPc.setLocalDescription(offer)
      if (wsRef.current) {
        wsRef.current.send(JSON.stringify({ 
          type: "call-offer", 
          roomId, 
          from: currentUser, 
          to: peerId, 
          payload: newPc.localDescription 
        }))
      }
    } catch (error) {
      console.error('Error in recreated peer connection offer:', error)
    }
  }  // Helper functions for consistent track management
  const getVideoSender = (pc: RTCPeerConnection) => {
    const senders = pc.getSenders()
    return senders[1] // Video is always at index 1
  }
  
  const getScreenSender = (pc: RTCPeerConnection) => {
    const senders = pc.getSenders()
    return senders[2] // Screen is always at index 2
  }

  // Fixed track order mapping for consistent SDP m-line ordering
  function createPeerConnection(remote: string) {
    const pc = new RTCPeerConnection(ICE_CONFIG)
    peerConnections.current[remote] = pc
    
    pc.onicecandidate = (e) => {
      if (e.candidate && wsRef.current) {
        wsRef.current.send(JSON.stringify({ type: "call-ice", roomId, from: currentUser, to: remote, payload: e.candidate }))
      }
    }
    
    pc.ontrack = (e) => {
      const track = e.track
      const stream = e.streams[0]
      
      console.log('Received track:', track.kind, track.label, 'from', remote)
      
      if (track.kind === 'audio') {
        setRemoteStreams(prev => ({ ...prev, [remote]: stream }))      
      }      else if (track.kind === 'video') {        // Enhanced screen track detection with better debugging
        const trackLabel = track.label.toLowerCase()
        const trackSettings = track.getSettings()
        
        console.log('Video track details:', {
          label: track.label,
          settings: trackSettings,
          id: track.id,
          kind: track.kind
        })
          // Helper function to get track info with proper dimension handling
        const getTrackInfo = (track: MediaStreamTrack) => {
          const settings = track.getSettings()
          const width = settings.width ?? 'unknown'
          const height = settings.height ?? 'unknown'
          const dimensions = width !== 'unknown' && height !== 'unknown' ? `${width}x${height}` : 'pending'
          
          return {
            label: track.label,
            settings: settings,
            dimensions: dimensions,
            hasImmediateDimensions: width !== 'unknown' && height !== 'unknown',
            displaySurface: settings.displaySurface,
            deviceId: settings.deviceId
          }
        }
        
        const trackInfo = getTrackInfo(track)
        console.log('📊 Video track analysis for', remote, ':', trackInfo)
        
        // Enhanced screen share detection with multiple reliable criteria
        const isScreenShare = 
          // Check display surface properties (most reliable)
          trackSettings.displaySurface === 'monitor' ||
          trackSettings.displaySurface === 'window' ||
          trackSettings.displaySurface === 'application' ||
          trackSettings.displaySurface === 'browser' ||
          // Check label patterns
          trackLabel.includes('screen') || 
          trackLabel.includes('monitor') ||
          trackLabel.includes('display') ||
          trackLabel.includes('desktop') ||
          trackLabel.includes('window') ||
          trackLabel.includes('tab') ||
          trackLabel.includes('application') ||
          trackLabel.includes('capture') ||
          trackLabel.includes('chrome') ||
          // Check for typical screen share dimensions (when available)
          (trackSettings.width && trackSettings.height && 
           trackSettings.width >= 1024 && trackSettings.height >= 768 &&
           (trackSettings.width >= 1920 || trackSettings.height >= 1080)) ||
          // Check constraints if available
          (track.getConstraints && track.getConstraints()?.displaySurface !== undefined)
          if (isScreenShare) {
          console.log('🖥️ SCREEN SHARE DETECTED for', remote, ':', {
            reason: 'Display surface or screen-like properties detected',
            trackInfo: trackInfo,
            criteria: {
              displaySurface: trackSettings.displaySurface,
              labelMatches: trackLabel.includes('screen') || trackLabel.includes('monitor') || trackLabel.includes('display'),
              dimensionBased: trackSettings.width && trackSettings.height && trackSettings.width >= 1024
            }
          })
          setRemoteScreenStreams(prev => ({ ...prev, [remote]: stream }))
        } else {
          console.log('📹 CAMERA VIDEO DETECTED for', remote, ':', {
            reason: 'No screen share indicators found',
            trackInfo: trackInfo,
            willWaitForDimensions: !trackInfo.hasImmediateDimensions
          })
          setRemoteVideoStreams(prev => ({ ...prev, [remote]: stream }))
        }
      }
    }
    
    // --- FIXED: Initialize with placeholder tracks to ensure consistent SDP m-line ordering ---
    console.log(`Creating peer connection for ${remote}. Initializing with fixed track order:`)
    
    // ALWAYS add tracks in this exact order: Audio -> Video -> Screen
    // Use placeholders to maintain consistent m-line structure across all peers
    
    // 1. Audio track (index 0) - ALWAYS present
    const audioTrack = localStreamRef.current?.getAudioTracks()[0] || createSilentAudioTrack()
    if (audioTrack) {
      pc.addTrack(audioTrack, localStreamRef.current || new MediaStream([audioTrack]))
      console.log(`  - [0] Audio: ${audioTrack.label || 'silent'} (enabled: ${audioTrack.enabled})`)
    }
    
    // 2. Video track (index 1) - ALWAYS present (real or placeholder)
    const videoTrack = localVideoStreamRef.current?.getVideoTracks()[0] || createPlaceholderVideoTrack()
    if (videoTrack) {
      pc.addTrack(videoTrack, localVideoStreamRef.current || new MediaStream([videoTrack]))
      console.log(`  - [1] Video: ${videoTrack.label || 'placeholder'} (enabled: ${videoTrack.enabled})`)
    }
    
    // 3. Screen track (index 2) - ALWAYS present (real or placeholder) 
    const screenTrack = localScreenStreamRef.current?.getVideoTracks()[0] || createPlaceholderVideoTrack()
    if (screenTrack && screenTrack !== videoTrack) { // Don't add same track twice
      pc.addTrack(screenTrack, localScreenStreamRef.current || new MediaStream([screenTrack]))
      console.log(`  - [2] Screen: ${screenTrack.label || 'placeholder'} (enabled: ${screenTrack.enabled})`)
    }
    
    console.log(`Peer connection for ${remote} created with FIXED track order (${pc.getSenders().length} senders)`)
    
    return pc
  }

  // Helper: Create a silent audio track for SDP consistency
  const createSilentAudioTrack = (): MediaStreamTrack | null => {
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext
      if (!AudioContextClass) return null
      
      const audioContext = new AudioContextClass()
      const oscillator = audioContext.createOscillator()
      const gainNode = audioContext.createGain()
      
      gainNode.gain.value = 0.001 // Very quiet
      oscillator.connect(gainNode)
      
      const destination = audioContext.createMediaStreamDestination()
      gainNode.connect(destination)
      
      oscillator.start()
      
      const track = destination.stream.getAudioTracks()[0]
      track.enabled = false // Start disabled
      return track
    } catch (error) {
      console.error('Error creating silent audio track:', error)
      return null
    }
  }
  // Helper: Create a placeholder video track for SDP consistency
  const createPlaceholderVideoTrack = (): MediaStreamTrack | null => {
    try {
      const canvas = document.createElement('canvas')
      canvas.width = 320  // Standard dimensions for placeholder
      canvas.height = 240
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.fillStyle = 'black'
        ctx.fillRect(0, 0, 320, 240)
        
        // Add some text to indicate it's a placeholder
        ctx.fillStyle = 'gray'
        ctx.font = '16px Arial'
        ctx.textAlign = 'center'
        ctx.fillText('No video', 160, 120)
      }
      const stream = canvas.captureStream(1)
      const track = stream.getVideoTracks()[0]
      track.enabled = false // Start disabled
      console.log('Created placeholder video track with dimensions:', canvas.width, 'x', canvas.height)
      return track
    } catch (error) {
      console.error('Error creating placeholder video track:', error)
      return null
    }
  }

// Join call room
  const joinCall = async () => {
    setConnecting(true)
    setError("")
    let localStream: MediaStream | null = null
      // Always try to get microphone permission
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      localStreamRef.current = localStream
      if (localAudioRef.current) {
        localAudioRef.current.srcObject = localStream
      }
      // Ensure audio tracks are enabled
      localStream.getAudioTracks().forEach(track => {
        track.enabled = true
        console.log('Audio track enabled:', track.label, track.enabled)
      })
      // Start unmuted if permission granted
      setMuted(false)
    } catch (err) {
      console.warn("Mic access denied, creating arbitrary audio track:", err)
      // Create arbitrary audio track to establish WebRTC connection
      localStream = createArbitraryAudioTrack()
      localStreamRef.current = localStream
      if (localAudioRef.current) {
        localAudioRef.current.srcObject = localStream
      }
      // Keep audio track disabled since user is muted
      setMuted(false)
      localStream.getAudioTracks().forEach(track => {
        track.enabled = false
        console.log('Join: Arbitrary audio track created but disabled (muted):', track.label)
      })
      handleMute() // Ensure muted state is set
      setError("Microphone access denied. Joined with silent audio track. Click unmute to try again.")
    }
    
    // Always join as a normal participant (never as listener)
    setActualIsListener(false)    // Connect to signaling with enhanced reconnection handling
    const ws = new WebSocket(SIGNALING_SERVER_URL)
    wsRef.current = ws
    
    // Add heartbeat to detect connection issues early
    let heartbeatInterval: NodeJS.Timeout | null = null
    let heartbeatTimeoutId: NodeJS.Timeout | null = null
    let missedHeartbeats = 0
    const MAX_MISSED_HEARTBEATS = 3
    
    const startHeartbeat = () => {
      if (heartbeatInterval) clearInterval(heartbeatInterval)
      missedHeartbeats = 0
      
      heartbeatInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping", timestamp: Date.now() }))
          
          // Set timeout to wait for pong response
          if (heartbeatTimeoutId) clearTimeout(heartbeatTimeoutId)
          heartbeatTimeoutId = setTimeout(() => {
            missedHeartbeats++
            console.log(`Call: Missed heartbeat ${missedHeartbeats}/${MAX_MISSED_HEARTBEATS}`)
            
            if (missedHeartbeats >= MAX_MISSED_HEARTBEATS) {
              console.log('Call: Too many missed heartbeats, triggering reconnection')
              setError("Connection unstable - attempting to reconnect...")
              ws.close() // This will trigger onclose and reconnection
            }
          }, 5000) // 5 second timeout for pong response
        }
      }, 15000) // Send ping every 15 seconds
    }
    
    const stopHeartbeat = () => {
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval)
        heartbeatInterval = null
      }
      if (heartbeatTimeoutId) {
        clearTimeout(heartbeatTimeoutId)
        heartbeatTimeoutId = null
      }
    }
      ws.onopen = () => {
      console.log('Call: WebSocket connected');
      ws.send(JSON.stringify({ type: "call-join", roomId, username: currentUser, isListener: false }))
      setJoined(true)
      setConnecting(false)
      setError("") // Clear any previous errors
      startHeartbeat() // Start heartbeat monitoring
    }
    ws.onmessage = async (event) => {
      const msg = JSON.parse(event.data)
      
      // Handle heartbeat responses
      if (msg.type === "pong") {
        missedHeartbeats = 0
        if (heartbeatTimeoutId) clearTimeout(heartbeatTimeoutId)
        console.log('Call: Received heartbeat pong')
        return
      }
      
      switch (msg.type) {case "call-new-peer": {
          const newPeer = msg.username
          if (newPeer === currentUser) return
          
          // Add to participants list
          setParticipants(prev => new Set([...prev, newPeer]))
          
          let pc = peerConnections.current[newPeer]
          if (!pc) {
            pc = createPeerConnection(newPeer)
          }
          
          // Check if we have any media to share (audio, video, or screen) - check actual streams not state
          const hasAudio = localStreamRef.current && localStreamRef.current.getTracks().length > 0
          const hasVideo = localVideoStreamRef.current && localVideoStreamRef.current.getTracks().length > 0
          const hasScreenShare = localScreenStreamRef.current && localScreenStreamRef.current.getTracks().length > 0
          const hasAnyMedia = hasAudio || hasVideo || hasScreenShare
            // Perfect negotiation rules with late-join fix
          const isImpolite = currentUser > newPeer
          const hasVisualMedia = hasVideo || hasScreenShare
          
          // CRITICAL FIX: Always create offer if we have video/screen to ensure late joiners see existing streams
          // For audio-only, follow normal politeness rules to avoid offer collision
          const shouldCreateOffer = !actualIsListener && (
            (isImpolite && hasAnyMedia) || // Normal impolite peer with any media
            hasVisualMedia // Always share video/screen regardless of politeness to fix late-join issue
          )
          
          if (shouldCreateOffer) {
            // ENHANCED FIX: Add screen tracks immediately if we're currently screen sharing
            if (hasScreenShare && localScreenStreamRef.current) {
              const screenTrack = localScreenStreamRef.current.getVideoTracks()[0]
              if (screenTrack && !pc.getSenders().some(sender => sender.track === screenTrack)) {
                pc.addTrack(screenTrack, localScreenStreamRef.current)
                console.log(`Added screen track to new peer ${newPeer} immediately`)
              }
            }
            
            // Add a small delay to let the polite peer potentially start negotiation first
            setTimeout(async () => {
              // Check if negotiation hasn't started yet
              if (pc && pc.signalingState === 'stable') {
                try {
                  console.log(`Creating offer for new peer ${newPeer}. Media: audio=${hasAudio}, video=${hasVideo}, screen=${hasScreenShare}, hasVisualMedia=${hasVisualMedia}`)
                  
                  // Force creation of offer to ensure all tracks are included
                  const offer = await pc.createOffer()
                  await pc.setLocalDescription(offer)
                  
                  // Log SDP for debugging
                  console.log(`Offer SDP for ${newPeer} includes:`, {
                    hasAudioLine: offer.sdp?.includes('m=audio'),
                    hasVideoLine: offer.sdp?.includes('m=video'),
                    videoLines: offer.sdp?.split('\n').filter(line => line.includes('video')).length || 0,
                    screenTrackIncluded: hasScreenShare
                  })
                  
                  ws.send(JSON.stringify({ type: "call-offer", roomId, from: currentUser, to: newPeer, payload: pc.localDescription }))
                } catch (error) {
                  console.error('Error creating offer for new peer:', error)
                }
              }
            }, 100) // Small delay to prevent race conditions
          } else {
            console.log(`Not creating offer for new peer ${newPeer}. shouldCreateOffer=${shouldCreateOffer}, isImpolite=${isImpolite}, hasAnyMedia=${hasAnyMedia}, hasVisualMedia=${hasVisualMedia}`)
          }
          break
        }case "call-offer": {
          const from = msg.from
          let pc = peerConnections.current[from]
          if (!pc) {
            pc = createPeerConnection(from)
          }
          
          // Perfect negotiation: determine politeness based on username comparison
          const isPolite = currentUser < from // Lexicographically smaller username is polite
          
          // Use safeSetRemoteDescription with politeness info
          const result = await safeSetRemoteDescription(pc, msg.payload, isPolite)
          if (result === 'recreate') {
            // Recreate the peer connection and try again
            await recreatePeerConnection(from)
            pc = peerConnections.current[from]
            if (pc) {
              await safeSetRemoteDescription(pc, msg.payload, isPolite)
            }
          } else if (result === 'ignored') {
            // Offer was ignored due to collision, don't create answer
            console.log(`Offer from ${from} was ignored due to collision`)
            break
          }
          
          // Only proceed if we have a valid peer connection and didn't ignore
          if (pc && pc.signalingState !== 'closed' && result === 'success') {
            try {
              const answer = await pc.createAnswer()
              await pc.setLocalDescription(answer)
              ws.send(JSON.stringify({ type: "call-answer", roomId, from: currentUser, to: from, payload: pc.localDescription }))
            } catch (error) {
              console.error('Error creating answer:', error)
            }
          }
          break
        }        case "call-answer": {
          const from = msg.from
          const pc = peerConnections.current[from]
          if (pc) {
            // Always use safeSetRemoteDescription to handle all states properly
            const result = await safeSetRemoteDescription(pc, msg.payload, currentUser < from)
            if (result === 'recreate') {
              // For answers, we usually don't recreate but log the issue
              console.log(`Answer processing failed for ${from}, may need full renegotiation`)
            } else if (result === 'ignored') {
              console.log(`Answer from ${from} was ignored (stale or wrong state)`)
            } else if (result === 'success') {
              console.log(`Successfully processed answer from ${from}`)
            }
          }
          break
        }
        case "call-ice": {
          const from = msg.from
          const pc = peerConnections.current[from]
          if (pc && msg.payload) {
            try { await pc.addIceCandidate(new RTCIceCandidate(msg.payload)) } catch {}
          }
          break
        }        case "call-peer-left": {
          const left = msg.username
          
          // Remove from participants list
          setParticipants(prev => {
            const newSet = new Set(prev)
            newSet.delete(left)
            return newSet
          })
          
          if (peerConnections.current[left]) {
            peerConnections.current[left].close()
            delete peerConnections.current[left]
          }          setRemoteStreams(prev => {
            const copy = { ...prev }
            delete copy[left]
            return copy
          })
          setRemoteVideoStreams(prev => {
            const copy = { ...prev }
            delete copy[left]
            return copy
          })
          setRemoteScreenStreams(prev => {
            const copy = { ...prev }
            delete copy[left]
            return copy
          })
          
          // Reset selected participant if they left
          setSelectedParticipant(prev => prev === left ? null : prev)
          
          break        }
      }
    }
    
    ws.onclose = () => {
      console.log('Call: WebSocket closed')
      stopHeartbeat() // Stop heartbeat monitoring
      setJoined(false)
      
      // Attempt automatic reconnection if we're still in the call
      if (currentUser && !reconnecting) {
        console.log('Call: Attempting automatic reconnection...')
        setError("Connection lost - attempting to reconnect...")
        setTimeout(() => {
          if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
            reconnectCall()
          }
        }, 3000) // Wait 3 seconds before reconnecting
      }
    }
    
    ws.onerror = (error) => {
      console.error('Call: WebSocket error:', error)
      stopHeartbeat() // Stop heartbeat monitoring
      setError("WebSocket connection error")
    }
  }  // Leave call room
  const leaveCall = () => {
    // Send leave message to server
    if (wsRef.current && currentUser) {
      wsRef.current.send(JSON.stringify({ type: "call-peer-left", roomId, username: currentUser }))
    }
    
    // Close all peer connections
    Object.values(peerConnections.current).forEach(pc => pc.close())
    peerConnections.current = {}
    
    // Stop local stream tracks
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop())
      localStreamRef.current = null
    }
    
    // Stop video stream tracks
    if (localVideoStreamRef.current) {
      localVideoStreamRef.current.getTracks().forEach(track => track.stop())
      localVideoStreamRef.current = null
    }
    
    // Stop screen stream tracks
    if (localScreenStreamRef.current) {
      localScreenStreamRef.current.getTracks().forEach(track => track.stop())
      localScreenStreamRef.current = null
    }
    
    // Close WebSocket connection and stop heartbeat
    if (wsRef.current) {
      // Note: stopHeartbeat function is defined inside joinCall scope
      // We'll clean up by closing the connection which triggers onclose
      wsRef.current.close()
      wsRef.current = null
    }
      // Reset state
    setJoined(false)
    setRemoteStreams({})
    setRemoteVideoStreams({})
    setRemoteScreenStreams({})
    setParticipants(new Set()) // Clear participants list
    setVideoEnabled(false)
    setScreenSharing(false)
    setSelectedParticipant(null)
    setError("")
    
    // Navigate back to chat
    router.push(`/${encodeURIComponent(roomId)}/chat`)  }
// Add local tracks to all peer connections when available using track replacement for consistency
  useEffect(() => {
    if (actualIsListener) return
    
    Object.values(peerConnections.current).forEach(pc => {
      const senders = pc.getSenders()
      
      // Handle audio tracks - replace or add as needed
      if (localStreamRef.current && localStreamRef.current.getTracks().length > 0) {
        const audioTrack = localStreamRef.current.getAudioTracks()[0]
        const audioSender = senders.find(sender => 
          !sender.track || sender.track.kind === 'audio'
        )
        
        if (audioSender && audioSender.track !== audioTrack) {
          audioSender.replaceTrack(audioTrack).catch(error => {
            console.error('Error replacing audio track:', error)
            // Fallback to add if replace fails
            if (!pc.getSenders().some(sender => sender.track === audioTrack)) {
              pc.addTrack(audioTrack, localStreamRef.current!)
            }
          })
        } else if (!audioSender) {
          // No audio sender exists, add the track
          if (!pc.getSenders().some(sender => sender.track === audioTrack)) {
            pc.addTrack(audioTrack, localStreamRef.current!)
            console.log(`Added audio track to existing PC: ${audioTrack.label}, enabled: ${audioTrack.enabled}`)
          }
        }
      }
      
      // Handle video tracks - replace or add as needed
      if (localVideoStreamRef.current && localVideoStreamRef.current.getTracks().length > 0) {
        const videoTrack = localVideoStreamRef.current.getVideoTracks()[0]
        const videoSender = senders.find(sender => 
          (!sender.track || sender.track.kind === 'video') && 
          !senders.some(s => s.track && s.track.label.includes('screen') && s === sender)
        )
        
        if (videoSender && videoSender.track !== videoTrack) {
          videoSender.replaceTrack(videoTrack).catch(error => {
            console.error('Error replacing video track:', error)
            // Fallback to add if replace fails
            if (!pc.getSenders().some(sender => sender.track === videoTrack)) {
              pc.addTrack(videoTrack, localVideoStreamRef.current!)
            }
          })
        } else if (!videoSender) {
          // No video sender exists, add the track
          if (!pc.getSenders().some(sender => sender.track === videoTrack)) {
            pc.addTrack(videoTrack, localVideoStreamRef.current!)
          }
        }
      }
      
      // Handle screen tracks - replace or add as needed
      if (localScreenStreamRef.current && localScreenStreamRef.current.getTracks().length > 0) {
        const screenTrack = localScreenStreamRef.current.getVideoTracks()[0]
        const screenSender = senders.find(sender => {
          if (!sender.track) return false
          return sender.track.kind === 'video' && 
                 (sender.track.label.toLowerCase().includes('screen') ||
                  sender.track.label.toLowerCase().includes('monitor') ||
                  sender.track.label.toLowerCase().includes('display'))
        })
        
        if (screenSender && screenSender.track !== screenTrack) {
          screenSender.replaceTrack(screenTrack).catch(error => {
            console.error('Error replacing screen track:', error)
            // Fallback to add if replace fails
            if (!pc.getSenders().some(sender => sender.track === screenTrack)) {
              pc.addTrack(screenTrack, localScreenStreamRef.current!)
            }
          })
        } else if (!screenSender) {
          // No screen sender exists, add the track
          if (!pc.getSenders().some(sender => sender.track === screenTrack)) {
            pc.addTrack(screenTrack, localScreenStreamRef.current!)
          }
        }
      }
    })
  }, [joined, actualIsListener, videoEnabled, screenSharing, muted]) // Added muted as dependency

  // Clean up on leave
  useEffect(() => {
    const pcs = peerConnections.current
    return () => {
      Object.values(pcs).forEach(pc => pc.close())
      if (wsRef.current) wsRef.current.close()
      if (localStreamRef.current) localStreamRef.current.getTracks().forEach(t => t.stop())
    }
  }, [roomId])
  // --- Mute/unmute a remote participant ---
  const togglePeerMute = (peer: string) => {
    setPeerMuted(prev => ({
      ...prev,
      [peer]: !prev[peer]
    }))
  }  // --- Switch camera between front and back ---
  const switchCamera = async () => {
    if (!videoEnabled) return

    const newCamera = currentCamera === 'user' ? 'environment' : 'user'

    if (newCamera === 'environment')
      setIsMirrored(false) // Back camera should not be mirrored
    else
      setIsMirrored(true) // Front camera should be mirrored
    
    try {
      // Stop current video stream
      if (localVideoStreamRef.current) {
        localVideoStreamRef.current.getTracks().forEach(track => track.stop())
      }

      // Get new video stream with the opposite camera
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { facingMode: newCamera }, 
        audio: false 
      })
      localVideoStreamRef.current = stream

      // Update local video preview immediately
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream
      }      // Update all peer connections with the new video track using fixed track ordering
      for (const [remote, pc] of Object.entries(peerConnections.current)) {
        const newVideoTrack = stream.getVideoTracks()[0]
        if (!newVideoTrack) continue
        
        // Use fixed track ordering - video is always at index 1
        const videoSender = getVideoSender(pc) // Always at index 1
        if (videoSender) {
          try {
            // Replace existing video track to maintain SDP m-line order
            await videoSender.replaceTrack(newVideoTrack)
            console.log(`Replaced video track with new camera for peer ${remote}`)
          } catch (error) {
            console.error('Error replacing video track during camera switch:', error)
          }
        } else {
          console.warn(`No video sender found at index 1 for peer ${remote} during camera switch`)
        }
        
        // Trigger renegotiation
        try {
          const offer = await pc.createOffer()
          await pc.setLocalDescription(offer)
          if (wsRef.current) {
            wsRef.current.send(JSON.stringify({ 
              type: "call-offer", 
              roomId, 
              from: currentUser, 
              to: remote, 
              payload: pc.localDescription 
            }))
          }
        } catch (error) {
          console.error('Error creating camera switch offer:', error)
        }
      }

      setCurrentCamera(newCamera)
    } catch (error) {
      console.error('Error switching camera:', error)
      setError('Camera switch failed - the requested camera may not be available')
    }
  }

  // --- Toggle mirror for local video preview ---
  const toggleMirror = () => {
    setIsMirrored(!isMirrored)
  }  // --- Toggle video with consistent track ordering (using fixed sender positions) ---
  const toggleVideo = async () => {
    if (videoEnabled) {
      // Turn off video
      if (localVideoStreamRef.current) {
        localVideoStreamRef.current.getTracks().forEach(track => track.stop())
        localVideoStreamRef.current = null
      }
      
      // Replace video track with placeholder to maintain m-line order
      for (const [remote, pc] of Object.entries(peerConnections.current)) {
        const videoSender = getVideoSender(pc) // Always at index 1
        if (videoSender) {
          try {
            const placeholderTrack = createPlaceholderVideoTrack()
            await videoSender.replaceTrack(placeholderTrack)
            console.log(`Replaced video track with placeholder for peer ${remote}`)
          } catch (error) {
            console.error('Error replacing video track with placeholder:', error)
          }
        }
        
        // Trigger renegotiation
        try {
          const offer = await pc.createOffer()
          await pc.setLocalDescription(offer)
          if (wsRef.current) {
            wsRef.current.send(JSON.stringify({ 
              type: "call-offer", 
              roomId, 
              from: currentUser, 
              to: remote, 
              payload: pc.localDescription 
            }))
          }
        } catch (error) {
          console.error('Error creating video-off offer:', error)
        }
      }
      
      setVideoEnabled(false)
    } else {
      // Turn on video
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
          video: { facingMode: currentCamera }, 
          audio: false 
        })
        localVideoStreamRef.current = stream
        
        // Replace placeholder video tracks with real video
        for (const [remote, pc] of Object.entries(peerConnections.current)) {
          const videoTrack = stream.getVideoTracks()[0]
          if (!videoTrack) continue
          
          const videoSender = getVideoSender(pc) // Always at index 1
          if (videoSender) {
            try {
              // Replace placeholder with real video track
              await videoSender.replaceTrack(videoTrack)
              console.log(`Replaced placeholder with video track for peer ${remote}`)
            } catch (error) {
              console.error('Error replacing placeholder with video track:', error)
            }
          }
          
          // Trigger renegotiation
          try {
            const offer = await pc.createOffer()
            await pc.setLocalDescription(offer)
            if (wsRef.current) {
              wsRef.current.send(JSON.stringify({ 
                type: "call-offer", 
                roomId, 
                from: currentUser, 
                to: remote, 
                payload: pc.localDescription 
              }))
            }
          } catch (error) {
            console.error('Error creating video offer:', error)
          }
        }
        
        setVideoEnabled(true)
      } catch (error) {
        console.error('Error accessing camera:', error)
        setError('Camera access denied')
      }
    }
  }  // --- Toggle screen sharing with proper renegotiation and consistent track ordering ---
  const toggleScreenShare = async () => {
    if (screenSharing) {
      // Turn off screen sharing
      if (localScreenStreamRef.current) {
        localScreenStreamRef.current.getTracks().forEach(track => track.stop())
        localScreenStreamRef.current = null
      }
      
      // Replace screen tracks with placeholder instead of null to maintain m-line order
      for (const [remote, pc] of Object.entries(peerConnections.current)) {
        const screenSender = getScreenSender(pc) // Always at index 2
        if (screenSender) {
          try {
            const placeholderTrack = createPlaceholderVideoTrack()
            await screenSender.replaceTrack(placeholderTrack)
            console.log(`Replaced screen track with placeholder for peer ${remote}`)
          } catch (error) {
            console.error('Error replacing screen track with placeholder:', error)
          }
        }
        
        // Trigger renegotiation
        try {
          const offer = await pc.createOffer()
          await pc.setLocalDescription(offer)
          if (wsRef.current) {
            wsRef.current.send(JSON.stringify({ 
              type: "call-offer", 
              roomId, 
              from: currentUser, 
              to: remote, 
              payload: pc.localDescription 
            }))
          }
        } catch (error) {
          console.error('Error creating screen-off offer:', error)
        }
      }
      
      setScreenSharing(false)
    } else {
      // Turn on screen sharing
      try {        
        // CRITICAL FIX: Request audio separately to avoid disrupting existing audio
        // Only request video for screen sharing to prevent audio conflicts
        const stream = await navigator.mediaDevices.getDisplayMedia({ 
          video: true, 
          audio: false // Always false to prevent audio conflicts with existing microphone stream
        })
        localScreenStreamRef.current = stream
        
        console.log('Screen share started, track label:', stream.getVideoTracks()[0]?.label)
        console.log('Screen share track details:', {
          label: stream.getVideoTracks()[0]?.label,
          settings: stream.getVideoTracks()[0]?.getSettings(),
          constraints: stream.getVideoTracks()[0]?.getConstraints()
        })
        
        // Replace placeholder screen tracks with real screen tracks
        for (const [remote, pc] of Object.entries(peerConnections.current)) {
          const screenTrack = stream.getVideoTracks()[0]
          if (!screenTrack) continue
          
          const screenSender = getScreenSender(pc) // Always at index 2
          if (screenSender) {
            try {
              // Replace placeholder with real screen track
              await screenSender.replaceTrack(screenTrack)
              console.log(`Replaced placeholder with screen track for peer ${remote}`)
            } catch (error) {
              console.error('Error replacing placeholder with screen track:', error)
            }
          }
          
          // Always trigger renegotiation after adding screen share
          try {
            const offer = await pc.createOffer()
            await pc.setLocalDescription(offer)
            if (wsRef.current) {
              wsRef.current.send(JSON.stringify({ 
                type: "call-offer", 
                roomId, 
                from: currentUser, 
                to: remote, 
                payload: pc.localDescription 
              }))
            }
            console.log(`Screen share offer sent to ${remote}`)
          } catch (error) {
            console.error('Error creating screen offer:', error)
          }
        }
        
        // Auto-stop when user stops sharing via browser UI
        stream.getVideoTracks()[0].addEventListener('ended', () => {
          console.log('Screen share ended by user')
          setScreenSharing(false)
          localScreenStreamRef.current = null
          
          // Clean up from peer connections using track replacement with placeholder
          Object.entries(peerConnections.current).forEach(async ([remote, pc]) => {
            const screenSender = getScreenSender(pc) // Always at index 2
            if (screenSender) {
              try {
                const placeholderTrack = createPlaceholderVideoTrack()
                await screenSender.replaceTrack(placeholderTrack)
                console.log(`Replaced ended screen track with placeholder for peer ${remote}`)
              } catch (error) {
                console.error('Error replacing ended screen track:', error)
              }
            }
            
            // Trigger renegotiation
            try {
              const offer = await pc.createOffer()
              await pc.setLocalDescription(offer)
              if (wsRef.current) {
                wsRef.current.send(JSON.stringify({ 
                  type: "call-offer", 
                  roomId, 
                  from: currentUser, 
                  to: remote, 
                  payload: pc.localDescription 
                }))
              }
            } catch (error) {
              console.error('Error creating cleanup offer:', error)
            }
          })
        })
          setScreenSharing(true)
      } catch (error) {
        console.error('Error accessing screen:', error)
        setError('Screen sharing access denied or not supported')
      }
    }
  }// Create arbitrary audio track when no microphone access
  const createArbitraryAudioTrack = (): MediaStream => {
    console.log('Creating arbitrary audio track for WebRTC connection')
    
    try {
      // Create audio context and generate silent audio
      const audioContext = new (window.AudioContext || window.webkitAudioContext)()
      const oscillator = audioContext.createOscillator()
      const gainNode = audioContext.createGain()
      
      // Create silent audio (very low volume but not completely silent)
      oscillator.frequency.setValueAtTime(440, audioContext.currentTime) // 440 Hz tone
      gainNode.gain.setValueAtTime(0.00001, audioContext.currentTime) // Very low volume, almost silent
      
      oscillator.connect(gainNode)
      
      // Create MediaStreamDestination to get a MediaStream
      const destination = audioContext.createMediaStreamDestination()
      gainNode.connect(destination)
      
      // Start the oscillator
      oscillator.start()
      
      const stream = destination.stream
      const audioTrack = stream.getAudioTracks()[0]
      
      if (audioTrack) {
        // Set track properties to make it identifiable
        Object.defineProperty(audioTrack, 'label', {
          value: 'Arbitrary Audio Track',
          writable: false
        })
        
        console.log('Arbitrary audio track created successfully:', {
          label: audioTrack.label,
          kind: audioTrack.kind,
          enabled: audioTrack.enabled,
          readyState: audioTrack.readyState,
          id: audioTrack.id
        })
      } else {
        console.warn('Failed to create audio track from arbitrary stream')
      }
      
      return stream
    } catch (error) {
      console.error('Error creating arbitrary audio track:', error)
      
      // Fallback: create a minimal media stream with silent track
      // This should work even if Web Audio API fails
      const canvas = document.createElement('canvas')
      canvas.width = 1
      canvas.height = 1
      const canvasStream = canvas.captureStream(1) // 1 FPS
      
      console.log('Created fallback canvas stream as audio substitute')
      return canvasStream
    }
  }

  // Reconnect to call - manually reset and reconnect all WebRTC connections
  const reconnectCall = async () => {
    if (!joined || reconnecting) return
    
    setReconnecting(true)
    setError("")
    console.log("Manual reconnection initiated...")
    
    try {
      // Store current media state to restore after reconnection
      const wasVideoEnabled = videoEnabled
      const wasScreenSharing = screenSharing
      const wasMuted = muted
      
      // Close all existing peer connections
      Object.values(peerConnections.current).forEach(pc => {
        console.log('Closing peer connection:', pc.signalingState)
        pc.close()
      })
      peerConnections.current = {}
      
      // Clear remote streams but keep participants list
      setRemoteStreams({})
      setRemoteVideoStreams({})
      setRemoteScreenStreams({})
      
      // Reset selected participant
      setSelectedParticipant(null)
      
      // Close and recreate WebSocket connection
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
      
      // Wait a moment for cleanup
      await new Promise(resolve => setTimeout(resolve, 500))
      
      // Recreate media streams if they were active
      let newLocalStream: MediaStream | null = null
      
      // Always create an audio stream - either real microphone or arbitrary track
      if (!wasMuted) {
        try {
          newLocalStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
          localStreamRef.current = newLocalStream
          if (localAudioRef.current) {
            localAudioRef.current.srcObject = newLocalStream
          }
          newLocalStream.getAudioTracks().forEach(track => {
            track.enabled = true
            console.log('Reconnect: Real audio track enabled:', track.label)
          })
          setMuted(false)
        } catch (err) {
          setMuted(false);
          console.warn("Reconnect: Mic access denied, creating arbitrary audio track:", err)
          // Create arbitrary audio track to establish WebRTC connection
          newLocalStream = createArbitraryAudioTrack()
          localStreamRef.current = newLocalStream
          if (localAudioRef.current) {
            localAudioRef.current.srcObject = newLocalStream
          }
          handleMute();
          setError("Microphone access denied. Reconnected with silent audio track. Click unmute to try again.")
        }
      } else {
        // Even if muted, create an arbitrary audio track for WebRTC connection establishment
        setMuted(false);
        console.log("Reconnect: Creating arbitrary audio track for muted user")
        newLocalStream = createArbitraryAudioTrack()
        localStreamRef.current = newLocalStream
        if (localAudioRef.current) {
          localAudioRef.current.srcObject = newLocalStream
        }
        // Keep audio track disabled since user was muted
        newLocalStream.getAudioTracks().forEach(track => {
          track.enabled = false
          console.log('Reconnect: Arbitrary audio track created but disabled (muted):', track.label)
        })
        setMuted(true)
      }
        // Recreate video stream if it was enabled
      if (wasVideoEnabled) {
        try {
          const videoStream = await navigator.mediaDevices.getUserMedia({ 
            video: { facingMode: currentCamera }, 
            audio: false 
          })
          localVideoStreamRef.current = videoStream
          setVideoEnabled(true)
          console.log('Reconnect: Video stream recreated')
        } catch (err) {
          console.warn("Reconnect: Video access denied:", err)
          setVideoEnabled(false)
        }
      }
      
      // Recreate screen share if it was active
      if (wasScreenSharing) {
        try {
          const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
          localScreenStreamRef.current = screenStream
          setScreenSharing(true)
          console.log('Reconnect: Screen share recreated')
          
          // Handle screen share end
          screenStream.getVideoTracks()[0].addEventListener('ended', () => {
            setScreenSharing(false)
            localScreenStreamRef.current = null
          })
        } catch (err) {
          console.warn("Reconnect: Screen share access denied:", err)
          setScreenSharing(false)
        }
      }
      
      // Reconnect WebSocket
      const ws = new WebSocket(SIGNALING_SERVER_URL)
      wsRef.current = ws
        ws.onopen = () => {
        console.log('Reconnect: WebSocket reconnected')
        ws.send(JSON.stringify({ type: "call-join", roomId, username: currentUser, isListener: false }))
        setJoined(true) // Ensure we stay in the call
        setReconnecting(false)
      }
      
      // Reuse the same message handler as joinCall
      ws.onmessage = async (event) => {
        const msg = JSON.parse(event.data)
        switch (msg.type) {
          case "call-new-peer": {
            const newPeer = msg.username
            if (newPeer === currentUser) return
            
            // Add to participants list (might already be there)
            setParticipants(prev => new Set([...prev, newPeer]))
            
            let pc = peerConnections.current[newPeer]
            if (!pc) {
              pc = createPeerConnection(newPeer)
            }
            
            // Check if we have any media to share
            const hasAudio = localStreamRef.current && localStreamRef.current.getTracks().length > 0
            const hasVideo = localVideoStreamRef.current && localVideoStreamRef.current.getTracks().length > 0
            const hasScreenShare = localScreenStreamRef.current && localScreenStreamRef.current.getTracks().length > 0
            const hasAnyMedia = hasAudio || hasVideo || hasScreenShare
              // Perfect negotiation rules with late-join fix
            const isImpolite = currentUser > newPeer
            const hasVisualMedia = hasVideo || hasScreenShare
            
            // CRITICAL FIX: Always create offer if we have video/screen to ensure late joiners see existing streams
            // For audio-only, follow normal politeness rules to avoid offer collision
            const shouldCreateOffer = !actualIsListener && (
              (isImpolite && hasAnyMedia) || // Normal impolite peer with any media
              hasVisualMedia // Always share video/screen regardless of politeness to fix late-join issue
            )
            
            if (shouldCreateOffer) {
              setTimeout(async () => {
                if (pc && pc.signalingState === 'stable') {
                  try {
                    console.log(`Reconnect: Creating offer for peer ${newPeer}. Media: audio=${hasAudio}, video=${hasVideo}, screen=${hasScreenShare}, hasVisualMedia=${hasVisualMedia}`)
                    const offer = await pc.createOffer()
                    await pc.setLocalDescription(offer)
                    ws.send(JSON.stringify({ 
                      type: "call-offer", 
                      roomId, 
                      from: currentUser, 
                      to: newPeer, 
                      payload: pc.localDescription 
                    }))
                  } catch (error) {
                    console.error('Reconnect: Error creating offer:', error)
                  }
                }
              }, 100)
            }
            break
          }
          
          // Handle other message types (same as joinCall)
          case "call-offer": {
            const from = msg.from
            let pc = peerConnections.current[from]
            if (!pc) {
              pc = createPeerConnection(from)
            }
            
            const isPolite = currentUser < from
            const result = await safeSetRemoteDescription(pc, msg.payload, isPolite)
            
            if (result === 'recreate') {
              await recreatePeerConnection(from)
              pc = peerConnections.current[from]
              if (pc) {
                await safeSetRemoteDescription(pc, msg.payload, isPolite)
              }
            } else if (result === 'ignored') {
              console.log(`Reconnect: Offer from ${from} was ignored due to collision`)
              break
            }
            
            if (pc && pc.signalingState !== 'closed' && result === 'success') {
              try {
                const answer = await pc.createAnswer()
                await pc.setLocalDescription(answer)
                ws.send(JSON.stringify({ 
                  type: "call-answer", 
                  roomId, 
                  from: currentUser, 
                  to: from, 
                  payload: pc.localDescription 
                }))
              } catch (error) {
                console.error('Reconnect: Error creating answer:', error)
              }
            }
            break
          }
            case "call-answer": {
            const from = msg.from
            const pc = peerConnections.current[from]
            if (pc) {
              // Always use safeSetRemoteDescription to handle all states properly
              const result = await safeSetRemoteDescription(pc, msg.payload, currentUser < from)
              if (result === 'recreate') {
                await recreatePeerConnection(from)
              } else if (result === 'ignored') {
                console.log(`Reconnect: Answer from ${from} was ignored (stale or wrong state)`)
              } else if (result === 'success') {
                console.log(`Reconnect: Successfully processed answer from ${from}`)
              }
            }
            break
          }
          
          case "call-ice": {
            const from = msg.from
            const pc = peerConnections.current[from]
            if (pc && msg.payload) {
              try { 
                await pc.addIceCandidate(new RTCIceCandidate(msg.payload)) 
              } catch (error) {
                console.error('Reconnect: ICE candidate error:', error)
              }
            }
            break
          }
          
          case "call-peer-left": {
            const left = msg.username
            setParticipants(prev => {
              const newSet = new Set(prev)
              newSet.delete(left)
              return newSet
            })
            
            if (peerConnections.current[left]) {
              peerConnections.current[left].close()
              delete peerConnections.current[left]
            }
            
            setRemoteStreams(prev => {
              const copy = { ...prev }
              delete copy[left]
              return copy
            })
            setRemoteVideoStreams(prev => {
              const copy = { ...prev }
              delete copy[left]
              return copy
            })
            setRemoteScreenStreams(prev => {
              const copy = { ...prev }
              delete copy[left]
              return copy
            })
            
            setSelectedParticipant(prev => prev === left ? null : prev)
            break
          }
        }
      }
        ws.onclose = () => {
        console.log('Reconnect: WebSocket closed')
        // Don't set joined to false during reconnection - keep the user in the call UI
        if (!reconnecting) {
          setJoined(false)
        }
        setReconnecting(false)
      }
      
      ws.onerror = (error) => {
        console.error('Reconnect: WebSocket error:', error)
        setError("Reconnection failed: WebSocket error")
        setReconnecting(false)
      }
      
    } catch (error) {
      console.error('Reconnection failed:', error)
      setError("Reconnection failed. Please try again.")
      setReconnecting(false)
    }
  }

  // Update document title when component mounts/unmounts
  useEffect(() => {
    // Set title to show we're in a call
    document.title = `Ucucu - Call`;

    // Cleanup: Reset title when component unmounts (user leaves call)
    return () => {
      document.title = "Ucucu";
    };
  }, []);

  return (
    <div className="h-screen bg-white flex flex-col">      <header className="bg-white border-b border-gray-200 px-4 py-3 flex-shrink-0">
        <div className="flex items-center justify-between gap-2 w-full flex-nowrap">
          <div className="flex items-center gap-2 min-w-0 flex-shrink">
            <Button variant="ghost" size="sm" onClick={() => router.push(`/${encodeURIComponent(roomId)}/chat`)}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <h1 className="font-semibold text-gray-900 truncate max-w-[80px]">Call</h1>
            <p className="text-xs text-gray-500 truncate max-w-[80px]">/{roomId}</p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0 min-w-0">
            {/* Reconnect Button - only show when joined */}
            {joined && (
              <Button
                size="sm"
                variant="outline"
                onClick={reconnectCall}
                disabled={reconnecting || connecting}
                className="flex items-center gap-1"
                title="Reconnect to resolve connection issues"
              >
                <RotateCcw className={`h-4 w-4 ${reconnecting ? 'animate-spin' : ''}`} />
                <span className="sm:inline">{reconnecting ? 'Reconnecting...' : 'Reconnect'}</span>
              </Button>
            )}
            <NotificationBell roomId={roomId} username={currentUser} />
          </div>
        </div>
      </header>
      <main className="flex-1 overflow-y-auto px-4 py-6 min-h-0">        {!joined ? (
          <div className="max-w-md mx-auto flex flex-col items-center gap-4">
            <div className="text-center mb-4">
              <h2 className="text-lg font-semibold mb-2">Join the Call</h2>
              <p className="text-sm text-gray-600">Choose how you want to join</p>
            </div>
              <div className="w-full space-y-3">
              <Button onClick={() => joinCall()} disabled={connecting} className="w-full">
                <Mic className="h-5 w-5 mr-2" /> Join Call
              </Button>
            </div>
            
            {error && <div className="text-red-600 text-sm mt-4 p-3 bg-red-50 rounded">{error}</div>}
              <div className="text-xs text-gray-500 text-center">
              Microphone permission will be requested automatically.<br/>
              If denied, you&apos;ll join muted and can unmute to try again.
            </div>
          </div>) : (
          <div className="h-full flex flex-col min-h-0 space-y-4">            {/* Control Panel */}
            <div className="bg-gray-50 rounded-lg p-3 flex-shrink-0">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="text-sm font-medium text-gray-700">Controls</div>
                <div className="flex items-center gap-2 flex-wrap">{/* Audio Controls */}
                  {!actualIsListener && (
                    <Button
                      size="sm"
                      variant={muted ? "destructive" : "outline"}
                      onClick={handleMute}
                      className="flex items-center gap-1"
                    >
                      {muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                      <span className="hidden sm:inline">{muted ? "Unmute" : "Mic"}</span>
                    </Button>
                  )}
                    {/* Video Controls */}
                  {!actualIsListener && (
                    <Button
                      size="sm"
                      variant={videoEnabled ? "default" : "outline"}
                      onClick={toggleVideo}
                      className="flex items-center gap-1"
                    >
                      {videoEnabled ? <Video className="h-4 w-4" /> : <VideoOff className="h-4 w-4" />}
                      <span className="hidden sm:inline">Video</span>
                    </Button>
                  )}
                  
                  {/* Camera Switch Controls - only show when video is enabled */}
                  {!actualIsListener && videoEnabled && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={switchCamera}
                      className="flex items-center gap-1"
                      title={`Switch to ${currentCamera === 'user' ? 'back' : 'front'} camera`}
                    >
                      <RotateCw className="h-4 w-4" />
                      <span className="hidden sm:inline">Flip</span>
                    </Button>
                  )}
                  
                  {/* Mirror Toggle Controls - only show when video is enabled */}
                  {!actualIsListener && videoEnabled && (
                    <Button
                      size="sm"
                      variant={isMirrored ? "default" : "outline"}
                      onClick={toggleMirror}
                      className="flex items-center gap-1"
                      title={`${isMirrored ? 'Disable' : 'Enable'} mirror effect for your video`}
                    >
                      <FlipHorizontal className="h-4 w-4" />
                      <span className="hidden sm:inline">Mirror</span>
                    </Button>
                  )}
                    {/* Screen Share Controls */}
                  {!actualIsListener && (
                    <Button
                      size="sm"
                      variant={screenSharing ? "default" : "outline"}
                      onClick={toggleScreenShare}
                      className="flex items-center gap-1"
                    >
                      {screenSharing ? <Monitor className="h-4 w-4" /> : <MonitorOff className="h-4 w-4" />}
                      <span className="hidden sm:inline">Screen</span>
                    </Button>
                  )}
                  
                  {/* Leave Call */}
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={leaveCall}
                    className="flex items-center gap-1"
                  >
                    <Phone className="h-4 w-4" />
                    <span className="hidden sm:inline">Leave</span>
                  </Button>
                </div>
              </div>
                {/* Local Speaking Indicator */}
              {!actualIsListener && (
                <div className={`mt-2 text-xs text-green-600 flex items-center gap-1 transition-opacity ${
                  localSpeaking ? 'opacity-100' : 'opacity-0'
                }`}>
                  <Volume2 className="h-3 w-3" />
                  <span>You are speaking</span>
                </div>
              )}
            </div>{/* Remove the selected participant modal view - we'll handle it in the grid */}            {/* Local Video Preview - smaller and positioned at top */}
            {videoEnabled && localVideoStreamRef.current && (
              <div className="bg-black rounded-lg mb-4 relative flex-shrink-0 w-full sm:w-64 self-start" style={{ aspectRatio: '16/9', height: 'auto' }}>
                <div className="absolute top-2 left-2 bg-black bg-opacity-50 text-white px-2 py-1 rounded text-xs">
                  You (Video)
                </div>
                <video
                  ref={localVideoRef}
                  autoPlay
                  playsInline
                  muted
                  className="w-full h-full object-cover rounded-lg"
                  style={{ transform: isMirrored ? 'scaleX(-1)' : 'none' }} // Mirror effect for front camera
                />
              </div>
            )}            {/* Local Screen Share Preview - same size as video preview */}
            {screenSharing && localScreenStreamRef.current && (
              <div className="bg-black rounded-lg mb-4 relative flex-shrink-0 w-full sm:w-80 self-start" style={{ aspectRatio: '16/9', height: 'auto' }}>
                <div className="absolute top-2 left-2 bg-black bg-opacity-50 text-white px-2 py-1 rounded text-xs">
                  Your Screen
                </div>
                <video
                  ref={localScreenRef}
                  autoPlay
                  playsInline
                  muted
                  className="w-full h-full object-contain rounded-lg"
                />
              </div>
            )}{/* Participants Grid */}
            <div className="flex-1 overflow-y-auto">
              <div className="font-semibold mb-4 text-sm">Participants</div>
              {participants.size === 0 ? (
                <div className="text-gray-400 text-sm text-center py-8">
                  No one else in the call yet.
                </div>
              ) : (                <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 sm:gap-4">
                  {Array.from(participants).map(peer => {
                    const isSelected = selectedParticipant === peer;
                    const hasVideo = remoteVideoStreams[peer];
                    const hasScreenShare = remoteScreenStreams[peer];
                    
                    return (
                      <div
                        key={peer}
                        className={`bg-gray-50 rounded-lg p-2 sm:p-3 border-2 transition-all cursor-pointer ${
                          isSelected ? 'border-blue-500 bg-blue-50 col-span-2 sm:col-span-2' : 'border-transparent hover:border-gray-300'
                        }`}
                        onClick={() => setSelectedParticipant(isSelected ? null : peer)}
                      >                        {/* Participant Video Container */}
                        <div 
                          className="relative bg-black rounded mb-2 sm:mb-3 aspect-video"
                        >
                          {hasVideo ? (
                            <video
                              ref={remoteVideoRefs.current[peer]}
                              autoPlay
                              playsInline
                              className="w-full h-full object-cover rounded"
                            />
                          ) : hasScreenShare ? (
                            <video
                              ref={remoteScreenRefs.current[peer]}
                              autoPlay
                              playsInline
                              className="w-full h-full object-contain rounded bg-gray-900"
                            />
                          ) : (                            <div className="w-full h-full flex items-center justify-center text-white">
                              <div className={`bg-gray-600 rounded-full flex items-center justify-center ${
                                isSelected ? 'w-12 h-12 sm:w-16 sm:h-16' : 'w-8 h-8 sm:w-12 sm:h-12'
                              }`}>
                                <span className={`font-semibold ${isSelected ? 'text-lg sm:text-xl' : 'text-sm sm:text-lg'}`}>
                                  {peer[0]?.toUpperCase()}
                                </span>
                              </div>
                            </div>
                          )}
                          
                          {/* Screen share indicator */}
                          {hasScreenShare && (
                            <div className="absolute top-2 right-2 bg-green-500 text-white p-1 rounded">
                              <Monitor className="h-3 w-3" />
                            </div>
                          )}
                          
                          {/* Selected indicator */}
                          {isSelected && (
                            <div className="absolute top-2 left-2 bg-blue-500 text-white px-2 py-1 rounded text-xs">
                              Expanded
                            </div>
                          )}
                        </div>
                          {/* Participant Name and Controls */}
                        <div className="flex items-center justify-between mb-1 sm:mb-2">
                          <div className={`font-medium text-gray-900 truncate ${
                            isSelected ? 'text-sm sm:text-base' : 'text-xs sm:text-sm'
                          }`}>
                            {peer}
                          </div>
                          
                          {/* Mute Button */}
                          <Button
                            size="sm"
                            variant={peerMuted[peer] ? "destructive" : "ghost"}
                            onClick={(e) => {
                              e.stopPropagation()
                              togglePeerMute(peer)
                            }}
                            className="p-1 h-6 w-6 sm:h-7 sm:w-7"
                          >
                            <MicOff className="h-2.5 w-2.5 sm:h-3 sm:w-3" style={{ display: peerMuted[peer] ? 'block' : 'none' }} />
                            <Mic className="h-2.5 w-2.5 sm:h-3 sm:w-3" style={{ display: peerMuted[peer] ? 'none' : 'block' }} />
                          </Button>
                        </div>
                          {/* Speaking Indicator */}
                        <div className={`flex items-center text-xs text-green-600 transition-opacity ${
                          speakingPeers[peer] ? 'opacity-100' : 'opacity-10'
                        }`}>
                          <Volume2 className="h-2.5 w-2.5 sm:h-3 sm:w-3 mr-1" />
                          <span className="text-xs">Speaking</span>
                        </div>
                        
                        {/* Hidden audio element */}
                        <audio
                          ref={remoteAudioRefs.current[peer]}
                          autoPlay
                          playsInline
                          controls={false}
                          muted={!!peerMuted[peer]}
                          className="hidden"
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            
            {/* Hidden local audio element */}
            {!actualIsListener && (
              <audio ref={localAudioRef} autoPlay controls={false} muted={true} className="hidden" />
            )}
          </div>
        )}
      </main>
    </div>
  )
}
