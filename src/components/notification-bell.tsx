"use client"

import { useState, useEffect, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Bell, BellOff } from "lucide-react"
import { notificationService, type NotificationInterval } from "@/lib/notification-service"
import { useWebSocket } from "@/components/WebSocketProvider"

interface NotificationBellProps {
  roomId: string
  username: string
  className?: string
}

export function NotificationBell({ roomId, username, className = "" }: NotificationBellProps) {
  const { send, lastMessage, isConnected } = useWebSocket()
  const [hasPermission, setHasPermission] = useState(false)
  const [isSubscribed, setIsSubscribed] = useState(false)
  const [remainingTime, setRemainingTime] = useState(0)
  const [currentInterval, setCurrentInterval] = useState<NotificationInterval>(0)
  const [pendingInterval, setPendingInterval] = useState<NotificationInterval | null>(null)
  const [graceTimeRemaining, setGraceTimeRemaining] = useState(0)

  // Update state from notification service
  const updateState = useCallback(() => {
    // Check notification permission status (same as web)
    const hasNotificationPermission = 'Notification' in window && Notification.permission === 'granted'
    setHasPermission(hasNotificationPermission)
    
    setIsSubscribed(notificationService.isSubscribed(roomId))
    setRemainingTime(notificationService.getRemainingTime(roomId))
    const subscription = notificationService.getSubscription(roomId)
    setCurrentInterval((subscription?.interval || 0) as NotificationInterval)
  }, [roomId])

  // Set up WebSocket communication and fetch status from backend
  useEffect(() => {
    console.log('[NotificationBell] Setting up WebSocket communication', { 
      send: typeof send, 
      isConnected,
      roomId,
      username
    })
    
    // Set the WebSocket send function in the notification service
    notificationService.setWebSocketSend(send)
    
    // Only fetch status and restore subscriptions when WebSocket is connected
    if (isConnected) {
      console.log('[NotificationBell] WebSocket connected - restoring subscriptions and fetching status')
      
      // Restore any existing subscriptions for this user
      notificationService.restoreSubscriptionsForUser(username)
      
      // Fetch current subscription status from backend for this room
      send({
        type: "getNotificationStatus",
        roomId,
        username
      })
    }
  }, [send, roomId, username, isConnected])

  // Handle backend messages
  useEffect(() => {
    if (lastMessage && (
      lastMessage.type === 'notificationStatus' || 
      lastMessage.type === 'notificationSubscribed' || 
      lastMessage.type === 'notificationUnsubscribed'
    )) {
      // Update local state from backend response
      if (lastMessage.type === 'notificationStatus' && lastMessage.roomId === roomId) {
        if (lastMessage.subscribed && typeof lastMessage.interval === 'number' && typeof lastMessage.remainingTime === 'number') {
          const subscription = {
            roomId,
            interval: lastMessage.interval,
            startTime: Date.now() - (lastMessage.interval * 60 * 1000 - lastMessage.remainingTime),
            endTime: Date.now() + lastMessage.remainingTime
          }
          notificationService.updateSubscriptionFromBackend(roomId, subscription)
        } else {
          // notificationService.removeSubscriptionFromBackend(roomId)
        }
        updateState()
      }
    }
  }, [lastMessage, roomId, updateState])
  useEffect(() => {
    updateState()
      // Update remaining time every second when subscribed
    const interval = setInterval(() => {
      if (notificationService.isSubscribed(roomId)) {
        setRemainingTime(notificationService.getRemainingTime(roomId))
      } else {
        updateState() // Refresh all state when subscription expires
      }
      
      // Update grace period countdown
      if (graceTimeRemaining > 0) {
        setGraceTimeRemaining(prev => prev - 1)
      }
    }, 1000)

    return () => {
      clearInterval(interval)    }  }, [roomId, updateState, graceTimeRemaining])

  // Apply pending interval when grace period expires
  const applyPendingInterval = useCallback(async () => {
    if (pendingInterval === null) return

    const intervalToApply = pendingInterval
    setPendingInterval(null)

    if (intervalToApply === 0) {
      // Disable notifications
      notificationService.unsubscribeFromRoom(roomId, username)
    } else {
      // Subscribe with new interval
      const success = await notificationService.subscribeToRoom(roomId, intervalToApply, username)
      if (!success) {
        console.error('[NotificationBell] Failed to subscribe to room notifications', roomId)
      }
    }

    // No need to call syncWithBackend here - the service methods handle it internally
    
    updateState()
  }, [pendingInterval, roomId, username, updateState])

  // Handle grace period expiration
  useEffect(() => {
    if (graceTimeRemaining === 0 && pendingInterval !== null) {
      applyPendingInterval()
    }
  }, [graceTimeRemaining, pendingInterval, applyPendingInterval])
  const handleBellClick = async () => {
    // If no permission, request it
    if (!hasPermission) {
      // Request permission using notification service
      const permission = await notificationService.requestNotificationPermission()
      
      if (permission !== 'granted') {
        return
      }
      
      setHasPermission(true)
    }    // If notifications are currently active (not in grace period), clicking disables them
    if (isSubscribed && graceTimeRemaining === 0) {
      // Immediately disable notifications
      notificationService.unsubscribeFromRoom(roomId, username)
      // No need to call syncWithBackend - unsubscribeFromRoom handles it internally
      updateState()
      return
    }    // If in grace period or no notifications active, cycle through intervals
    const baseInterval = pendingInterval !== null ? pendingInterval : currentInterval
    const nextInterval = notificationService.getNextInterval(baseInterval, roomId)
    
    // Set pending interval and start/restart 5-second grace period
    setPendingInterval(nextInterval)
    setGraceTimeRemaining(5)
  }

  const getBellIcon = () => {
    if (!hasPermission || (!isSubscribed && graceTimeRemaining === 0)) {
      return BellOff
    }
    return Bell
  }

  const getBellSize = () => {
    // When timer is active or in grace period, make bell smaller
    return (isSubscribed || graceTimeRemaining > 0) ? "h-3 w-3" : "h-4 w-4"
  }
  const formatTime = (seconds: number): string => {
    const minutes = Math.floor(seconds / 60)
    const hours = Math.floor(minutes / 60)
    const days = Math.floor(hours / 24)
    
    if (days > 0) {
      return `${days}d`
    } else if (hours > 0) {
      return `${hours}h`
    } else if (minutes > 0) {
      return `${minutes}m`
    } else {
      return `${seconds}s`
    }
  }

  const BellIcon = getBellIcon()
  return (
    <div className={`flex flex-col items-center justify-center ${className}`}>
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 rounded-full hover:bg-gray-100"
          onClick={handleBellClick}          title={
            !hasPermission
              ? "Enable notifications"
              : graceTimeRemaining > 0
              ? `Setting ${pendingInterval === 360 ? '6h' : pendingInterval === 1440 ? '24h' : `${pendingInterval}min`} notifications in ${graceTimeRemaining}s (click to cycle)`
              : !isSubscribed
              ? "Click to enable room notifications"
              : `Notifications active for ${formatTime(remainingTime)} (click to disable)`
          }
        >          <BellIcon 
            className={`${getBellSize()} ${
              !hasPermission || (!isSubscribed && graceTimeRemaining === 0)
                ? "text-gray-400" 
                : graceTimeRemaining > 0
                ? "text-orange-500"
                : "text-blue-600"            }`} 
          />
        </Button>
      </div>
        {/* Timer display when notifications are active or in grace period */}
      {graceTimeRemaining > 0 ? (        <div className="text-xs text-orange-500 font-mono leading-none -mt-1">
          {pendingInterval === 360 ? '6h' : pendingInterval === 1440 ? '24h' : `${pendingInterval}m`} in {graceTimeRemaining}s
        </div>
      ) : isSubscribed && remainingTime > 0 && (
        <div className="text-xs text-gray-500 font-mono leading-none -mt-1">
          {formatTime(remainingTime)}
        </div>
      )}
    </div>
  )
}
