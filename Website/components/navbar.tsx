"use client"

import Link from "next/link"
import { useSession, signOut } from "next-auth/react"
import { Button } from "@/components/ui/button"

export function Navbar() {
  const { data: session } = useSession()

  return (
    <nav className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container flex h-16 items-center justify-between">
        <Link href="/" className="text-xl font-bold">
          RestaurantVoice
        </Link>
        <div className="flex items-center gap-4">
          {session ? (
            <>
              <Link href="/dashboard">
                <Button variant="ghost">Dashboard</Button>
              </Link>
              <Button variant="outline" onClick={() => signOut()}>
                Abmelden
              </Button>
            </>
          ) : (
            <>
              <Link href="/pricing">
                <Button variant="ghost">Preise</Button>
              </Link>
              <Link href="/login">
                <Button variant="ghost">Anmelden</Button>
              </Link>
              <Link href="/register">
                <Button>Kostenlos starten</Button>
              </Link>
            </>
          )}
        </div>
      </div>
    </nav>
  )
}
